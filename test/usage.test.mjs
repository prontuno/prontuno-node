import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Prontuno, ProntunoConfigError } from "prontuno";

const usage = {
    subscription: {
        plan: "standard",
        status: "active",
        is_active: true,
        period_start: "2026-10-01T00:00:00.000Z",
        period_end: "2026-11-01T00:00:00.000Z",
        cancel_at_period_end: false,
        recipients_included: 500000,
        recipients_used: 128450,
        recipients_remaining: 371550,
    },
    credits: { balance: 25000, expires_at: "2027-10-01T00:00:00.000Z" },
    limits: {
        domains: { used: 12, limit: 1000 },
        shared_teams: { used: 2, limit: 5 },
        api_keys: { used: 8, limit: 1000 },
        smtp_credentials: { used: 3, limit: 1000 },
    },
};

describe("usage", () => {
    test("retrieves usage with the management key", async () => {
        const calls = [];
        const client = new Prontuno({
            sendingKey: "send",
            managementKey: "manage",
            fetch: async (input, init) => {
                calls.push({
                    line: `${init.method} ${String(input)}`,
                    key: init.headers.get("Authorization"),
                });
                return new Response(JSON.stringify(usage), {
                    headers: { "Content-Type": "application/json" },
                });
            },
        });

        assert.deepEqual(await client.usage.retrieve(), usage);
        assert.deepEqual(calls, [
            { line: "GET https://api.prontuno.net/v1/usage", key: "Bearer manage" },
        ]);
    });

    test("requires a management key", async () => {
        const client = new Prontuno({ sendingKey: "send", fetch: async () => assert.fail() });

        await assert.rejects(client.usage.retrieve(), (error) => {
            assert.ok(error instanceof ProntunoConfigError);
            assert.match(error.message, /GET \/usage requires a management API key/);
            return true;
        });
    });
});
