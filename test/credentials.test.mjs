import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Prontuno, ProntunoApiError } from "prontuno";

function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });
}

function recordingClient(responses, options = {}) {
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
    return { calls, client: new Prontuno({ apiKey: "test", fetch, maxRetries: 0, ...options }) };
}

const apiKey = {
    id: "key_01kfzeb03ae59a98z11nhxnrkj",
    name: "Production sender",
    type: "sending",
    scopes: ["email:send"],
    domain_id: "dom_01kfzeb03ae59a98z11nhxnrkk",
    domain: "mg.example.com",
    status: "active",
    created_via: "api",
    created_at: "2026-10-15T10:00:00.000Z",
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
};

const smtpCredential = {
    id: "smtp_01kfzeb03ae59a98z11nhxnrkm",
    name: "Legacy app",
    domain_id: "dom_01kfzeb03ae59a98z11nhxnrkk",
    domain: "mg.example.com",
    username: "pno_smtp_01kfzeb03ae59a98z11nhxnrkn",
    status: "active",
    created_via: "api",
    created_at: "2026-10-15T10:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
};

describe("API keys", () => {
    test("creates, retrieves, and revokes API keys", async () => {
        const { calls, client } = recordingClient([
            { status: 201, body: { ...apiKey, key: "pno_sk_secret" } },
            { body: apiKey },
            null,
        ]);

        const created = await client.apiKeys.create({
            name: "Production sender",
            type: "sending",
            domain_id: apiKey.domain_id,
        });
        assert.equal(created.key, "pno_sk_secret");
        assert.equal((await client.apiKeys.retrieve(apiKey.id)).scopes[0], "email:send");
        assert.equal(await client.apiKeys.revoke(apiKey.id), undefined);

        assert.deepEqual(
            calls.map(({ method, url }) => `${method} ${url}`),
            [
                "POST https://api.prontuno.net/v1/api-keys",
                `GET https://api.prontuno.net/v1/api-keys/${apiKey.id}`,
                `DELETE https://api.prontuno.net/v1/api-keys/${apiKey.id}`,
            ],
        );
        assert.deepEqual(calls[0].body, {
            name: "Production sender",
            type: "sending",
            domain_id: apiKey.domain_id,
        });
    });

    test("sends MCP keys with optional email sending", async () => {
        const { calls, client } = recordingClient([
            { status: 201, body: { ...apiKey, type: "mcp", key: "a" } },
            { status: 201, body: { ...apiKey, type: "management", key: "b" } },
        ]);

        await client.apiKeys.create({
            name: "Agent",
            type: "mcp",
            allow_email_sending: true,
            domain_id: apiKey.domain_id,
        });
        await client.apiKeys.create({ name: "Admin", type: "management" });

        assert.deepEqual(calls[0].body, {
            name: "Agent",
            type: "mcp",
            allow_email_sending: true,
            domain_id: apiKey.domain_id,
        });
        assert.deepEqual(calls[1].body, { name: "Admin", type: "management" });
    });

    test("lists API keys with status and type filters across pages", async () => {
        const { calls, client } = recordingClient([
            {
                body: {
                    data: [apiKey],
                    pagination: { limit: 1, has_more: true, next_cursor: "c2" },
                },
            },
            {
                body: {
                    data: [{ ...apiKey, id: "key_2", status: "revoked" }],
                    pagination: { limit: 1, has_more: false, next_cursor: null },
                },
            },
        ]);

        const ids = [];
        for await (const key of client.apiKeys.listAll({
            limit: 1,
            status: "all",
            type: "sending",
        })) {
            ids.push(key.id);
        }

        assert.deepEqual(ids, [apiKey.id, "key_2"]);
        assert.equal(
            calls[0].url,
            "https://api.prontuno.net/v1/api-keys?limit=1&status=all&type=sending",
        );
        assert.equal(
            calls[1].url,
            "https://api.prontuno.net/v1/api-keys?limit=1&cursor=c2&status=all&type=sending",
        );
    });

    test("surfaces already-revoked conflicts", async () => {
        const { client } = recordingClient([
            {
                status: 409,
                body: {
                    error: {
                        code: "already_revoked",
                        message: "API key is already revoked.",
                        retryable: false,
                    },
                },
            },
        ]);

        const error = await client.apiKeys.revoke(apiKey.id).catch((caught) => caught);
        assert.ok(error instanceof ProntunoApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, "already_revoked");
    });

    test("does not retry API key creation", async () => {
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

        await assert.rejects(
            client.apiKeys.create({ name: "Admin", type: "management" }),
            ProntunoApiError,
        );
        assert.equal(attempts, 1);
    });
});

describe("SMTP credentials", () => {
    test("creates, retrieves, resets, and revokes SMTP credentials", async () => {
        const { calls, client } = recordingClient([
            { status: 201, body: { ...smtpCredential, password: "first" } },
            { body: smtpCredential },
            { body: { ...smtpCredential, password: "second" } },
            null,
        ]);

        const created = await client.smtpCredentials.create({
            name: "Legacy app",
            domain_id: smtpCredential.domain_id,
        });
        assert.equal(created.password, "first");
        assert.equal(created.username, smtpCredential.username);
        assert.equal((await client.smtpCredentials.retrieve(smtpCredential.id)).name, "Legacy app");
        assert.equal(
            (await client.smtpCredentials.resetPassword(smtpCredential.id)).password,
            "second",
        );
        assert.equal(await client.smtpCredentials.revoke(smtpCredential.id), undefined);

        assert.deepEqual(
            calls.map(({ method, url }) => `${method} ${url}`),
            [
                "POST https://api.prontuno.net/v1/smtp-credentials",
                `GET https://api.prontuno.net/v1/smtp-credentials/${smtpCredential.id}`,
                `POST https://api.prontuno.net/v1/smtp-credentials/${smtpCredential.id}/reset-password`,
                `DELETE https://api.prontuno.net/v1/smtp-credentials/${smtpCredential.id}`,
            ],
        );
        assert.deepEqual(calls[0].body, {
            name: "Legacy app",
            domain_id: smtpCredential.domain_id,
        });
        assert.equal(calls[2].body, undefined);
    });

    test("lists SMTP credentials with a status filter", async () => {
        const { calls, client } = recordingClient([
            {
                body: {
                    data: [smtpCredential],
                    pagination: { limit: 10, has_more: false, next_cursor: null },
                },
            },
            {
                body: {
                    data: [smtpCredential],
                    pagination: { limit: 10, has_more: false, next_cursor: null },
                },
            },
        ]);

        const page = await client.smtpCredentials.list({ limit: 10, status: "revoked" });
        const all = await Array.fromAsync(client.smtpCredentials.listAll({ status: "all" }));

        assert.equal(page.data[0].id, smtpCredential.id);
        assert.equal(all.length, 1);
        assert.equal(
            calls[0].url,
            "https://api.prontuno.net/v1/smtp-credentials?limit=10&status=revoked",
        );
        assert.equal(calls[1].url, "https://api.prontuno.net/v1/smtp-credentials?status=all");
    });

    test("does not retry password resets", async () => {
        let attempts = 0;
        const client = new Prontuno({
            apiKey: "test",
            fetch: async () => {
                attempts += 1;
                return jsonResponse(
                    { error: { code: "internal_error", message: "Boom", retryable: true } },
                    { status: 503 },
                );
            },
        });

        await assert.rejects(
            client.smtpCredentials.resetPassword(smtpCredential.id),
            ProntunoApiError,
        );
        assert.equal(attempts, 1);
    });
});
