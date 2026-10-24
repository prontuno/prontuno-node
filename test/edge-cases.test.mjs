import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import {
    Prontuno,
    ProntunoApiError,
    ProntunoConfigError,
    ProntunoConnectionError,
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

function recordingClient(responder, options = {}) {
    const calls = [];
    const fetch = async (input, init) => {
        calls.push({
            url: String(input),
            method: init.method,
            headers: init.headers,
            body: init.body === undefined ? undefined : JSON.parse(init.body),
        });
        return responder(calls.length);
    };
    return { calls, client: new Prontuno({ apiKey: "test", fetch, ...options }) };
}

describe("client configuration", () => {
    test("rejects invalid client options", () => {
        for (const options of [
            { timeout: 0 },
            { timeout: Number.NaN },
            { maxRetries: -1 },
            { maxRetries: 1.5 },
            { baseUrl: "not a url" },
            { baseUrl: "ftp://api.example.com/v1" },
            { baseUrl: "api.example.com/v1" },
            { baseUrl: "http://localhost.example.com/v1" },
        ]) {
            assert.throws(() => new Prontuno({ apiKey: "test", ...options }), ProntunoConfigError);
        }
    });

    test("adds appInfo after the SDK's own User-Agent", async () => {
        const agents = [];
        for (const appInfo of [undefined, null, "  ", " my-app/1.2.0 "]) {
            const { calls, client } = recordingClient(() => jsonResponse({ id: "dom_1" }), {
                appInfo,
            });
            await client.domains.retrieve("dom_1");
            agents.push(calls[0].headers.get("user-agent"));
        }

        assert.deepEqual(agents, [
            "prontuno-node/0.2.0",
            "prontuno-node/0.2.0",
            "prontuno-node/0.2.0",
            "prontuno-node/0.2.0 my-app/1.2.0",
        ]);
        for (const appInfo of ["my-app\r\nX-Injected: 1", 42]) {
            assert.throws(
                () => new Prontuno({ apiKey: "test", appInfo }),
                /appInfo must be a single-line string/,
            );
        }
    });

    test("reads PRONTUNO_BASE_URL unless an explicit baseUrl is given", async () => {
        const original = process.env.PRONTUNO_BASE_URL;
        const urls = [];
        const fetch = async (input) => {
            urls.push(String(input));
            return jsonResponse({ id: "email_1" });
        };

        try {
            process.env.PRONTUNO_BASE_URL = " https://env.example.com/v1/ ";
            await new Prontuno({ apiKey: "test", fetch }).emails.retrieve("email_1");
            await new Prontuno({
                apiKey: "test",
                fetch,
                baseUrl: "https://option.example.com/v1",
            }).emails.retrieve("email_1");

            process.env.PRONTUNO_BASE_URL = "   ";
            await new Prontuno({ apiKey: "test", fetch }).emails.retrieve("email_1");

            process.env.PRONTUNO_BASE_URL = "http://env.example.com/v1";
            assert.throws(() => new Prontuno({ apiKey: "test", fetch }), /must use https/);
        } finally {
            if (original === undefined) {
                delete process.env.PRONTUNO_BASE_URL;
            } else {
                process.env.PRONTUNO_BASE_URL = original;
            }
        }

        assert.deepEqual(urls, [
            "https://env.example.com/v1/emails/email_1",
            "https://option.example.com/v1/emails/email_1",
            "https://api.prontuno.net/v1/emails/email_1",
        ]);
    });

    test("accepts https and loopback http base urls", () => {
        for (const options of [
            { baseUrl: "HTTPS://api.example.com/v1" },
            { baseUrl: "http://localhost:8000/v1" },
            { baseUrl: "http://[::1]:8000/v1" },
            { baseUrl: "http://127.0.0.1:8000/v1" },
        ]) {
            assert.ok(new Prontuno({ apiKey: "test", ...options }) instanceof Prontuno);
        }
    });

    test("requires a fetch implementation", () => {
        const original = globalThis.fetch;
        globalThis.fetch = undefined;
        try {
            assert.throws(() => new Prontuno("test"), /No fetch implementation/);
        } finally {
            globalThis.fetch = original;
        }
    });

    test("rejects invalid per-request options", async () => {
        const { client } = recordingClient(() => jsonResponse({}));
        await assert.rejects(client.emails.retrieve("email_1", { timeout: -1 }), /timeout/);
        await assert.rejects(client.emails.retrieve("email_1", { maxRetries: -1 }), /maxRetries/);
        await assert.rejects(
            client.emails.retrieve("email_1", { maxResponseSize: 0 }),
            /maxResponseSize/,
        );
    });
});

describe("resource methods", () => {
    test("covers remaining domain, email, and suppression calls", async () => {
        const { calls, client } = recordingClient((n) =>
            n === 4 ? new Response(null, { status: 204 }) : jsonResponse({ emails: [] }),
        );

        await client.domains.retrieve("dom_1");
        await client.emails.sendBatch(
            [
                {
                    from: "a@example.com",
                    to: "b@example.com",
                    subject: "Hi",
                    text: "Hi",
                    attachments: [
                        { filename: "a.txt", content: "aGk=", encoding: "base64" },
                        { filename: "b.txt", content: new Uint8Array([104, 105]) },
                    ],
                },
            ],
            { idempotencyKey: "batch-1" },
        );
        await client.suppressions.create({ email: "x@example.com" });
        assert.equal(await client.suppressions.delete("x@example.com"), undefined);

        assert.deepEqual(
            calls.map(({ method, url }) => `${method} ${url}`),
            [
                "GET https://api.prontuno.net/v1/domains/dom_1",
                "POST https://api.prontuno.net/v1/emails/batch",
                "POST https://api.prontuno.net/v1/suppressions",
                "DELETE https://api.prontuno.net/v1/suppressions/x%40example.com",
            ],
        );
        assert.deepEqual(calls[1].body.emails[0].attachments, [
            { filename: "a.txt", content: "aGk=", encoding: "base64" },
            { filename: "b.txt", content: "aGk=", encoding: "base64" },
        ]);
        assert.equal(calls[1].headers.get("Idempotency-Key"), "batch-1");
        assert.deepEqual(calls[2].body, { email: "x@example.com" });
    });

    test("listAll resumes from a starting cursor", async () => {
        const { calls, client } = recordingClient(() =>
            jsonResponse({
                data: [{ id: "dom_2" }],
                pagination: { limit: 1, has_more: false, next_cursor: null },
            }),
        );

        const items = await Array.fromAsync(client.domains.listAll({ cursor: "start" }));

        assert.deepEqual(items, [{ id: "dom_2" }]);
        assert.equal(calls[0].url, "https://api.prontuno.net/v1/domains?cursor=start");
    });
});

describe("response handling", () => {
    test("rejects empty and invalid successful responses", async () => {
        for (const response of [
            new Response(null, { status: 200 }),
            new Response("", { status: 200 }),
            new Response("not json", { status: 200 }),
        ]) {
            const client = new Prontuno({ apiKey: "test", fetch: async () => response });
            await assert.rejects(client.emails.retrieve("email_1"), ProntunoConnectionError);
        }
    });

    test("normalizes error bodies that are empty, non-JSON, or not objects", async () => {
        const cases = [
            [new Response("", { status: 404 }), "api_error", false],
            [new Response("Bad gateway", { status: 502 }), "invalid_response", false],
            [jsonResponse(["unexpected"], { status: 503 }), "api_error", true],
        ];

        for (const [response, code, retryable] of cases) {
            const client = new Prontuno({
                apiKey: "test",
                maxRetries: 0,
                fetch: async () => response,
            });
            const error = await client.emails.retrieve("email_1").catch((caught) => caught);
            assert.ok(error instanceof ProntunoApiError);
            assert.equal(error.code, code);
            assert.equal(error.retryable, retryable);
        }
    });

    test("keeps the size error when cancelling an oversized body fails", async () => {
        const fakeResponse = {
            ok: true,
            status: 200,
            headers: new Headers({ "content-length": "100" }),
            body: {
                cancel: async () => {
                    throw new Error("cancel failed");
                },
            },
        };
        const client = new Prontuno({
            apiKey: "test",
            maxResponseSize: 10,
            fetch: async () => fakeResponse,
        });

        await assert.rejects(client.emails.retrieve("email_1"), /exceeded the maximum size/);
    });

    test("skips empty stream chunks", async () => {
        const chunks = [
            { done: false, value: undefined },
            { done: false, value: new TextEncoder().encode('{"id":"email_1"}') },
            { done: true, value: undefined },
        ];
        const fakeResponse = {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: { getReader: () => ({ read: async () => chunks.shift() }) },
        };
        const client = new Prontuno({ apiKey: "test", fetch: async () => fakeResponse });

        assert.deepEqual(await client.emails.retrieve("email_1"), { id: "email_1" });
    });
});

describe("network failures and retries", () => {
    test("wraps network errors for requests that are not retried", async () => {
        const cause = new TypeError("fetch failed");
        const client = new Prontuno({
            apiKey: "test",
            fetch: async () => {
                throw cause;
            },
        });

        const error = await client.domains
            .create({ domain: "example.com" })
            .catch((caught) => caught);
        assert.ok(error instanceof ProntunoConnectionError);
        assert.equal(error.cause, cause);
    });

    test("rethrows connection errors raised by a custom fetch", async () => {
        const original = new ProntunoConnectionError("custom failure");
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 0,
            fetch: async () => {
                throw original;
            },
        });

        await assert.rejects(client.emails.retrieve("email_1"), (error) => error === original);
    });

    test("retries network errors with exponential backoff", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 1,
            fetch: async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new TypeError("socket hang up");
                }
                return jsonResponse({ id: "email_1" });
            },
        });

        assert.deepEqual(await client.emails.retrieve("email_1"), { id: "email_1" });
        assert.equal(attempts, 2);
    });

    test("ignores non-numeric rate-limit headers", async () => {
        const client = new Prontuno({
            apiKey: "test",
            fetch: async () =>
                jsonResponse(
                    { id: "email_1" },
                    { headers: { "RateLimit-Limit": "lots", "RateLimit-Remaining": "5" } },
                ),
        });

        await client.emails.retrieve("email_1");
        assert.equal(client.lastResponse.rateLimit.limit, null);
        assert.equal(client.lastResponse.rateLimit.remaining, 5);
    });

    test("retries sends while the same idempotency key is still in progress", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 1,
            fetch: async () => {
                attempts += 1;
                return attempts === 1
                    ? jsonResponse(
                          {
                              error: {
                                  code: "idempotency_request_in_progress",
                                  message: "In progress",
                                  retryable: true,
                              },
                          },
                          { status: 409, headers: { "Retry-After": "0" } },
                      )
                    : jsonResponse({ emails: [] }, { status: 202 });
            },
        });

        await client.emails.send(
            { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hi" },
            { idempotencyKey: "key-1" },
        );
        assert.equal(attempts, 2);
    });

    test("does not retry other conflicts", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            fetch: async () => {
                attempts += 1;
                return jsonResponse(
                    {
                        error: {
                            code: "idempotency_key_reused",
                            message: "Reused",
                            retryable: false,
                        },
                    },
                    { status: 409 },
                );
            },
        });

        await assert.rejects(
            client.emails.send(
                { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hi" },
                { idempotencyKey: "key-1" },
            ),
            ProntunoApiError,
        );
        assert.equal(attempts, 1);
    });

    test("honours HTTP-date Retry-After headers", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 1,
            fetch: async () => {
                attempts += 1;
                return attempts === 1
                    ? jsonResponse(
                          { error: { code: "rate_limited", message: "Slow", retryable: true } },
                          {
                              status: 429,
                              headers: {
                                  "Retry-After": new Date(Date.now() - 1_000).toUTCString(),
                              },
                          },
                      )
                    : jsonResponse({ id: "email_1" });
            },
        });

        assert.deepEqual(await client.emails.retrieve("email_1"), { id: "email_1" });
        assert.equal(attempts, 2);
    });
});

describe("deletes retried after an uncertain attempt", () => {
    const failure = (status, code) =>
        jsonResponse({ error: { code, message: "Failed", retryable: status >= 500 } }, { status });

    test("treat a 404 after a server error as success", async () => {
        const { calls, client } = recordingClient(
            (attempt) => (attempt === 1 ? failure(503, "unavailable") : failure(404, "not_found")),
            { maxRetries: 1 },
        );

        assert.equal(await client.webhooks.delete("whk_1"), undefined);
        assert.equal(calls.length, 2);
    });

    test("treat already_revoked after a network error as success", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 1,
            fetch: async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new TypeError("socket hang up");
                }
                return failure(409, "already_revoked");
            },
        });

        assert.equal(await client.apiKeys.revoke("key_1"), undefined);
        assert.equal(attempts, 2);
    });

    test("still reject a 404 on the first attempt or after a rate limit", async () => {
        const first = recordingClient(() => failure(404, "not_found"), { maxRetries: 1 });
        await assert.rejects(first.client.webhooks.delete("whk_1"), ProntunoApiError);

        const limited = recordingClient(
            (attempt) => (attempt === 1 ? failure(429, "rate_limited") : failure(404, "not_found")),
            { maxRetries: 1 },
        );
        await assert.rejects(limited.client.suppressions.delete("sup_1"), ProntunoApiError);
        assert.equal(limited.calls.length, 2);
    });

    test("still reject other conflicts after a server error", async () => {
        const { client } = recordingClient(
            (attempt) =>
                attempt === 1 ? failure(500, "internal_error") : failure(409, "conflict"),
            { maxRetries: 1 },
        );

        await assert.rejects(client.smtpCredentials.revoke("smtp_1"), ProntunoApiError);
    });
});

describe("identifiers", () => {
    test("reject empty and dot-segment identifiers before any request", async () => {
        const { calls, client } = recordingClient(() => jsonResponse({}));

        for (const id of ["", " ", ".", ".."]) {
            await assert.rejects(client.webhooks.delete(id), ProntunoConfigError);
        }
        await assert.rejects(
            client.emails.attachments.retrieve("email_1", ""),
            /attachment identifier is required/,
        );
        assert.equal(calls.length, 0);
    });
});

describe("abort signals", () => {
    test("rejects immediately with an already-aborted signal", async () => {
        const controller = new AbortController();
        controller.abort(new Error("cancelled"));
        const client = new Prontuno({
            apiKey: "test",
            fetch: async (_input, init) => {
                if (init.signal.aborted) {
                    throw init.signal.reason;
                }
                return jsonResponse({});
            },
        });

        await assert.rejects(
            client.emails.retrieve("email_1", { signal: controller.signal }),
            /cancelled/,
        );
    });

    test("stops waiting between retries when the caller aborts", async () => {
        const controller = new AbortController();
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 2,
            fetch: async () => {
                setTimeout(() => controller.abort(new Error("caller aborted")), 5);
                return jsonResponse(
                    { error: { code: "unavailable", message: "Down", retryable: true } },
                    { status: 503, headers: { "Retry-After": "30" } },
                );
            },
        });

        await assert.rejects(
            client.emails.retrieve("email_1", { signal: controller.signal }),
            /caller aborted/,
        );
    });

    test("rejects without waiting when the retry delay starts after an abort", async () => {
        const controller = new AbortController();
        const client = new Prontuno({
            apiKey: "test",
            maxRetries: 1,
            fetch: async () => {
                const response = jsonResponse(
                    { error: { code: "unavailable", message: "Down", retryable: true } },
                    { status: 503 },
                );
                controller.abort(new Error("aborted before delay"));
                return response;
            },
        });

        await assert.rejects(
            client.emails.retrieve("email_1", { signal: controller.signal }),
            /aborted before delay/,
        );
    });
});

describe("webhook verification edge cases", () => {
    const timestamp = 1_719_230_400;
    const secret = "whsec_test";
    const sign = (body) =>
        `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

    test("validates inputs and signature format", () => {
        const body = "{}";
        assert.throws(() => verifyWebhookSignature(body, "", secret), /Missing Prontuno-Signature/);
        assert.throws(() => verifyWebhookSignature(body, sign(body), ""), /secret is required/);
        assert.throws(() => verifyWebhookSignature(body, "t=abc,v1=00", secret), /invalid format/);
        assert.throws(
            () => verifyWebhookSignature(body, `t=${timestamp}`, secret),
            /invalid format/,
        );
        assert.throws(
            () => verifyWebhookSignature(body, `t=${timestamp},v1=not-hex`, secret),
            WebhookSignatureVerificationError,
        );
        assert.throws(
            () =>
                verifyWebhookSignature(body, sign(body), secret, { now: timestamp, tolerance: -1 }),
            /non-negative/,
        );
    });

    test("uses the current time when none is provided", () => {
        const body = "{}";
        const now = Math.floor(Date.now() / 1_000);
        const signature = `t=${now},v1=${createHmac("sha256", secret).update(`${now}.${body}`).digest("hex")}`;

        assert.equal(verifyWebhookSignature(body, signature, secret), true);
        assert.throws(() => verifyWebhookSignature(body, sign(body), secret), /tolerance window/);
    });

    test("skips the timestamp check when tolerance is zero", () => {
        const body = "{}";
        assert.equal(verifyWebhookSignature(body, sign(body), secret, { tolerance: 0 }), true);
    });

    test("treats a v1 entry without a value as a mismatch", () => {
        assert.throws(
            () => verifyWebhookSignature("{}", `t=${timestamp},v1`, secret, { now: timestamp }),
            /does not match/,
        );
    });

    test("verifies binary bodies through the client helper", () => {
        const body = "{}";
        const client = new Prontuno("test");
        assert.equal(
            client.webhooks.verifySignature(body, sign(body), secret, { now: timestamp }),
            true,
        );
        assert.equal(
            client.webhooks.verifySignature(new TextEncoder().encode(body), sign(body), secret, {
                now: new Date(timestamp * 1_000),
            }),
            true,
        );
    });

    test("rejects signed payloads that are not valid event objects", () => {
        for (const body of ["not json", "[]", "null"]) {
            assert.throws(
                () => constructWebhookEvent(body, sign(body), secret, { now: timestamp }),
                WebhookPayloadError,
            );
        }

        const binary = new TextEncoder().encode('{"type":"email.sent"}');
        assert.throws(
            () =>
                constructWebhookEvent(binary, sign('{"type":"email.sent"}'), secret, {
                    now: timestamp,
                }),
            WebhookPayloadError,
        );
    });
});
