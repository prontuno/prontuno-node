import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import {
    Prontuno,
    ProntunoApiError,
    ProntunoConfigError,
    ProntunoConnectionError,
    ProntunoTimeoutError,
    WebhookPayloadError,
    WebhookSignatureVerificationError,
    constructWebhookEvent,
    verifyWebhookSignature,
} from "prontuno";

function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });
}

describe("Prontuno client", () => {
    test("requires an API key", () => {
        assert.throws(() => new Prontuno(""), ProntunoConfigError);
        assert.throws(() => new Prontuno("   "), ProntunoConfigError);
        assert.throws(() => new Prontuno(undefined), ProntunoConfigError);
        assert.throws(() => new Prontuno({ apiKey: "\t" }), ProntunoConfigError);
        assert.throws(
            () => new Prontuno({ apiKey: "test", maxResponseSize: 0 }),
            ProntunoConfigError,
        );
    });

    test("requires HTTPS except for loopback endpoints", async () => {
        assert.throws(
            () => new Prontuno({ apiKey: "test", baseUrl: "http://example.test/v1" }),
            /baseUrl must use https/,
        );

        let requestUrl = "";
        const client = new Prontuno({
            apiKey: "test",
            baseUrl: "http://127.0.0.1:3000/v1",
            fetch: async (input) => {
                requestUrl = String(input);
                return jsonResponse({ id: "email_1" });
            },
        });

        await client.emails.retrieve("email_1");
        assert.equal(requestUrl, "http://127.0.0.1:3000/v1/emails/email_1");
    });

    test("sends an email with auth, idempotency, and binary attachments", async () => {
        let requestUrl = "";
        let requestInit;
        const fetch = async (input, init) => {
            requestUrl = String(input);
            requestInit = init;
            return jsonResponse(
                { emails: [{ id: "email_123", to: "ada@example.com" }] },
                {
                    status: 202,
                    headers: {
                        "x-request-id": "req_123",
                        "RateLimit-Limit": "100",
                        "RateLimit-Remaining": "99",
                        "RateLimit-Reset": "42",
                    },
                },
            );
        };
        const client = new Prontuno({
            apiKey: "  pno_sk_test  ",
            baseUrl: "https://example.test/v1/",
            fetch,
        });

        const result = await client.emails.send(
            {
                from: "Prontuno <hello@example.com>",
                to: "ada@example.com",
                subject: "Welcome",
                text: "Hello",
                attachments: [
                    { filename: "hello.txt", content: new TextEncoder().encode("hello") },
                ],
            },
            { idempotencyKey: "send_123" },
        );

        assert.equal(requestUrl, "https://example.test/v1/emails");
        assert.equal(new Headers(requestInit.headers).get("authorization"), "Bearer pno_sk_test");
        assert.equal(new Headers(requestInit.headers).get("idempotency-key"), "send_123");
        assert.deepEqual(JSON.parse(String(requestInit.body)).attachments, [
            { filename: "hello.txt", content: "aGVsbG8=", encoding: "base64" },
        ]);
        assert.equal(result.emails[0]?.id, "email_123");
        assert.deepEqual(client.lastResponse, {
            requestId: "req_123",
            rateLimit: { limit: 100, remaining: 99, reset: 42 },
        });
    });

    test("builds list filters and retrieves pages through listAll", async () => {
        const urls = [];
        const fetch = async (input) => {
            const url = new URL(String(input));
            urls.push(url.toString());
            const cursor = url.searchParams.get("cursor");
            return jsonResponse({
                data: [{ id: cursor ? "email_2" : "email_1" }],
                pagination: { limit: 1, has_more: !cursor, next_cursor: cursor ? null : "next" },
            });
        };
        const client = new Prontuno({ apiKey: "test", baseUrl: "https://example.test/v1", fetch });
        const ids = [];

        for await (const email of client.emails.listAll({
            limit: 1,
            status: "delivered",
            domain_id: "dom_1",
        })) {
            ids.push(email.id);
        }

        assert.deepEqual(ids, ["email_1", "email_2"]);
        assert.match(urls[0], /limit=1/);
        assert.match(urls[0], /status=delivered/);
        assert.match(urls[1], /cursor=next/);
    });

    test("percent-encodes email suppression identifiers", async () => {
        let requestUrl = "";
        const fetch = async (input) => {
            requestUrl = String(input);
            return jsonResponse({
                id: "sup_1",
                email: "user+tag@example.com",
                type: "manual",
                suppressed_at: null,
            });
        };
        const client = new Prontuno({ apiKey: "test", baseUrl: "https://example.test/v1", fetch });

        await client.suppressions.retrieve("user+tag@example.com");

        assert.equal(requestUrl, "https://example.test/v1/suppressions/user%2Btag%40example.com");
    });

    test("exposes structured API errors", async () => {
        const fetch = async () =>
            jsonResponse(
                {
                    error: { code: "validation_failed", message: "Request validation failed" },
                    errors: [
                        {
                            code: "missing_subject",
                            message: "subject is required",
                            field: "subject",
                        },
                    ],
                },
                { status: 400, headers: { "x-request-id": "req_error" } },
            );
        const client = new Prontuno({ apiKey: "test", fetch, maxRetries: 0 });

        await assert.rejects(
            client.emails.send({
                from: "a@example.com",
                to: "b@example.com",
                subject: "",
                text: "Hi",
            }),
            (error) => {
                assert.ok(error instanceof ProntunoApiError);
                assert.equal(error.status, 400);
                assert.equal(error.code, "validation_failed");
                assert.equal(error.requestId, "req_error");
                assert.equal(error.retryable, false);
                assert.equal(error.details?.[0]?.field, "subject");
                return true;
            },
        );
    });

    test("retries GET requests after transient failures", async () => {
        let attempts = 0;
        const fetch = async () => {
            attempts += 1;
            if (attempts === 1) {
                return jsonResponse(
                    {
                        error: {
                            code: "internal_server_error",
                            message: "Try again",
                            retryable: true,
                        },
                    },
                    { status: 500, headers: { "Retry-After": "0" } },
                );
            }
            return jsonResponse({ id: "email_1" });
        };
        const client = new Prontuno({ apiKey: "test", fetch });

        await client.emails.retrieve("email_1");

        assert.equal(attempts, 2);
    });

    test("waits for Retry-After without counting the wait against the timeout", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            timeout: 20,
            maxRetries: 1,
            fetch: async () => {
                attempts += 1;
                return jsonResponse(
                    { error: { code: "rate_limited", message: "Wait" } },
                    { status: 429, headers: { "Retry-After": "0.05" } },
                );
            },
        });

        await assert.rejects(
            client.emails.retrieve("email_1"),
            (error) => error instanceof ProntunoApiError && error.status === 429,
        );
        assert.equal(attempts, 2);
    });

    test("applies the timeout to each attempt and retries timed-out reads", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            timeout: 20,
            maxRetries: 1,
            fetch: async (_input, init) => {
                attempts += 1;
                if (attempts === 1) {
                    return new Promise((_resolve, reject) => {
                        init.signal.addEventListener("abort", () => reject(init.signal.reason));
                    });
                }
                return jsonResponse({ id: "email_1" });
            },
        });

        assert.deepEqual(await client.emails.retrieve("email_1"), { id: "email_1" });
        assert.equal(attempts, 2);
    });

    test("does not retry timed-out sends without an idempotency key", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            timeout: 20,
            fetch: async (_input, init) => {
                attempts += 1;
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(init.signal.reason));
                });
            },
        });

        await assert.rejects(
            client.emails.send({
                from: "a@example.com",
                to: "b@example.com",
                subject: "Hi",
                text: "Hi",
            }),
            ProntunoTimeoutError,
        );
        assert.equal(attempts, 1);
    });

    test("rejects oversized responses without retrying them", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 2,
            maxResponseSize: 32,
            fetch: async () => {
                attempts += 1;
                return jsonResponse(
                    { data: "x".repeat(64) },
                    { headers: { "Content-Length": "1" } },
                );
            },
        });

        await assert.rejects(
            client.emails.retrieve("email_1"),
            (error) =>
                error instanceof ProntunoConnectionError &&
                /exceeded the maximum size of 32 bytes/.test(error.message),
        );
        assert.equal(attempts, 1);

        const declaredLargeResponse = new Prontuno({
            apiKey: "test",
            maxResponseSize: 32,
            fetch: async () =>
                jsonResponse({ id: "email_1" }, { headers: { "Content-Length": "1024" } }),
        });
        await assert.rejects(
            declaredLargeResponse.emails.retrieve("email_1"),
            /exceeded the maximum size of 32 bytes/,
        );
    });

    test("bounds automatic pagination and rejects cursor cycles", async () => {
        for (const resourceName of [
            "emails",
            "domains",
            "suppressions",
            "webhooks",
            "apiKeys",
            "smtpCredentials",
        ]) {
            let attempts = 0;
            const client = new Prontuno({
                apiKey: "test",
                maxRetries: 0,
                fetch: async () => {
                    attempts += 1;
                    return jsonResponse({
                        data: [],
                        pagination: { limit: 1, has_more: true, next_cursor: "repeat" },
                    });
                },
            });

            await assert.rejects(
                client[resourceName].listAll({ limit: 1 }).next(),
                /repeated pagination cursor/,
            );
            assert.equal(attempts, 2);
        }

        const cappedClient = new Prontuno({
            apiKey: "test",
            maxRetries: 0,
            fetch: async () =>
                jsonResponse({
                    data: [],
                    pagination: { limit: 1, has_more: true, next_cursor: "next" },
                }),
        });
        await assert.rejects(
            cappedClient.emails.listAll({ maxPages: 1 }).next(),
            /exceeded the maximum of 1 pages/,
        );
        await assert.rejects(
            cappedClient.emails.listAll({ maxPages: 0 }).next(),
            ProntunoConfigError,
        );

        const inconsistentClient = new Prontuno({
            apiKey: "test",
            maxRetries: 0,
            fetch: async () =>
                jsonResponse({
                    data: [],
                    pagination: { limit: 1, has_more: true, next_cursor: null },
                }),
        });
        await assert.rejects(
            inconsistentClient.emails.listAll().next(),
            /more results without a next cursor/,
        );

        let terminatingAttempts = 0;
        const terminatingClient = new Prontuno({
            apiKey: "test",
            fetch: async () => {
                terminatingAttempts += 1;
                return jsonResponse({
                    data: [],
                    pagination: { limit: 1, has_more: false, next_cursor: "ignored" },
                });
            },
        });
        assert.deepEqual(await Array.fromAsync(terminatingClient.emails.listAll()), []);
        assert.equal(terminatingAttempts, 1);
    });

    test("does not automatically retry non-idempotent creates", async () => {
        let attempts = 0;
        const fetch = async () => {
            attempts += 1;
            return jsonResponse(
                { error: { code: "internal_server_error", message: "Try again", retryable: true } },
                { status: 500 },
            );
        };
        const client = new Prontuno({ apiKey: "test", fetch });

        await assert.rejects(client.domains.create({ domain: "example.com" }), ProntunoApiError);
        assert.equal(attempts, 1);
    });
});

describe("webhook management", () => {
    function recordingClient(responses) {
        const calls = [];
        const fetch = async (input, init) => {
            calls.push({
                url: String(input),
                method: init.method,
                body: init.body === undefined ? undefined : JSON.parse(init.body),
            });
            const next = responses.shift();
            if (next === null) {
                return new Response(null, { status: 204 });
            }
            return jsonResponse(next.body, { status: next.status ?? 200 });
        };
        return { calls, client: new Prontuno({ apiKey: "test", fetch, maxRetries: 0 }) };
    }

    const webhook = {
        id: "whk_1",
        name: "Production",
        url: "https://example.com/hooks",
        events: ["email.delivered"],
        domain_id: null,
        is_global: true,
        is_enabled: true,
        created_at: "2026-06-28T11:20:58.412Z",
    };

    test("creates, retrieves, updates, rotates, and deletes webhooks", async () => {
        const { calls, client } = recordingClient([
            { status: 201, body: { ...webhook, secret: "whsec_1" } },
            { body: webhook },
            { body: { ...webhook, is_enabled: false } },
            { body: { id: "whk_1", secret: "whsec_2" } },
            null,
        ]);

        const created = await client.webhooks.create({
            name: "Production",
            url: "https://example.com/hooks",
            events: ["email.delivered"],
        });
        assert.equal(created.secret, "whsec_1");
        assert.equal((await client.webhooks.retrieve("whk_1")).id, "whk_1");
        const updated = await client.webhooks.update("whk_1", { is_enabled: false });
        assert.equal(updated.is_enabled, false);
        assert.equal((await client.webhooks.rotateSecret("whk_1")).secret, "whsec_2");
        assert.equal(await client.webhooks.delete("whk_1"), undefined);

        assert.deepEqual(
            calls.map(({ method, url }) => `${method} ${url}`),
            [
                "POST https://api.prontuno.net/v1/webhooks",
                "GET https://api.prontuno.net/v1/webhooks/whk_1",
                "PATCH https://api.prontuno.net/v1/webhooks/whk_1",
                "POST https://api.prontuno.net/v1/webhooks/whk_1/rotate-secret",
                "DELETE https://api.prontuno.net/v1/webhooks/whk_1",
            ],
        );
        assert.deepEqual(calls[2].body, { is_enabled: false });
        assert.equal(calls[3].body, undefined);
    });

    test("sends is_global with domain_id when switching a webhook's scope", async () => {
        const scoped = { ...webhook, domain_id: "dom_1", is_global: false };
        const { calls, client } = recordingClient([{ body: scoped }, { body: webhook }]);

        await client.webhooks.update("whk_1", { is_global: false, domain_id: "dom_1" });
        await client.webhooks.update("whk_1", { is_global: true, domain_id: null });

        assert.deepEqual(
            calls.map((call) => call.body),
            [
                { is_global: false, domain_id: "dom_1" },
                { is_global: true, domain_id: null },
            ],
        );
    });

    test("lists webhooks across pages", async () => {
        const { calls, client } = recordingClient([
            {
                body: {
                    data: [webhook],
                    pagination: { limit: 1, has_more: true, next_cursor: "c2" },
                },
            },
            {
                body: {
                    data: [{ ...webhook, id: "whk_2" }],
                    pagination: { limit: 1, has_more: false, next_cursor: null },
                },
            },
        ]);

        const ids = [];
        for await (const item of client.webhooks.listAll({ limit: 1 })) {
            ids.push(item.id);
        }

        assert.deepEqual(ids, ["whk_1", "whk_2"]);
        assert.equal(calls[1].url, "https://api.prontuno.net/v1/webhooks?limit=1&cursor=c2");
    });

    test("does not retry webhook updates", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            fetch: async () => {
                attempts += 1;
                return jsonResponse(
                    { error: { code: "internal_error", message: "Boom", retryable: true } },
                    { status: 500 },
                );
            },
        });

        await assert.rejects(client.webhooks.update("whk_1", { name: "x" }), ProntunoApiError);
        assert.equal(attempts, 1);
    });
});

describe("webhooks", () => {
    const timestamp = 1_719_230_400;
    const body = JSON.stringify({
        event_id: "evt_123",
        webhook_id: "whk_123",
        type: "email.delivered",
        created_at: "2026-06-28T11:20:58.412Z",
        data: { email_id: "email_123" },
    });
    const secret = "whsec_test";
    const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const signature = `t=${timestamp},v1=${digest}`;

    test("verifies the exact raw payload and constructs a typed event", () => {
        assert.equal(verifyWebhookSignature(body, signature, secret, { now: timestamp }), true);
        const event = constructWebhookEvent(body, signature, secret, { now: timestamp });
        assert.equal(event.type, "email.delivered");
        assert.equal(event.event_id, "evt_123");
    });

    test("rejects changed payloads and stale signatures", () => {
        assert.throws(
            () => verifyWebhookSignature(`${body}\n`, signature, secret, { now: timestamp }),
            WebhookSignatureVerificationError,
        );
        assert.throws(
            () => verifyWebhookSignature(body, signature, secret, { now: timestamp + 301 }),
            /tolerance window/,
        );
        assert.throws(
            () => verifyWebhookSignature(body, signature, secret, { now: Number.NaN }),
            /verification time must be finite/,
        );
        assert.throws(
            () => verifyWebhookSignature(body, signature, secret, { now: new Date(Number.NaN) }),
            /verification time must be finite/,
        );
        assert.throws(
            () => verifyWebhookSignature(body, signature, secret, { now: "not-a-time" }),
            /verification time must be finite/,
        );
    });

    test("accepts expired and complained events through the client helper", () => {
        const client = new Prontuno("test");
        for (const type of ["email.expired", "email.complained"]) {
            const eventBody = JSON.stringify({
                event_id: "evt_2",
                webhook_id: "whk_1",
                type,
                created_at: "2026-06-28T11:20:58.412Z",
                data: { email_id: "email_2" },
            });
            const eventDigest = createHmac("sha256", secret)
                .update(`${timestamp}.${eventBody}`)
                .digest("hex");
            const event = client.webhooks.constructEvent(
                eventBody,
                `t=${timestamp},v1=${eventDigest}`,
                secret,
                { now: timestamp },
            );
            assert.equal(event.type, type);
        }
    });

    test("rejects payloads missing required fields after verifying the signature", () => {
        const invalidBody = JSON.stringify({
            event_id: "evt_1",
            webhook_id: "whk_1",
            type: "other",
        });
        const invalidDigest = createHmac("sha256", secret)
            .update(`${timestamp}.${invalidBody}`)
            .digest("hex");
        assert.throws(
            () =>
                constructWebhookEvent(invalidBody, `t=${timestamp},v1=${invalidDigest}`, secret, {
                    now: timestamp,
                }),
            WebhookPayloadError,
        );
    });

    test("passes through event types this SDK version does not know", () => {
        const futureBody = JSON.stringify({
            event_id: "evt_3",
            webhook_id: "whk_1",
            type: "email.opened",
            created_at: "2026-06-28T11:20:58.412Z",
            data: { email_id: "email_3" },
        });
        const futureDigest = createHmac("sha256", secret)
            .update(`${timestamp}.${futureBody}`)
            .digest("hex");
        const event = constructWebhookEvent(
            futureBody,
            `t=${timestamp},v1=${futureDigest}`,
            secret,
            { now: timestamp },
        );
        assert.equal(event.type, "email.opened");
    });
});
