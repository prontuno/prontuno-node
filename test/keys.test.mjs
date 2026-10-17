import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Prontuno, ProntunoConfigError } from "prontuno";

function keyRecorder() {
    const calls = [];
    const fetch = async (input, init) => {
        calls.push({
            line: `${init.method} ${String(input).replace("https://api.prontuno.net/v1", "")}`,
            key: init.headers.get("Authorization"),
        });
        const body = init.method === "POST" ? { emails: [] } : { data: [], pagination: {} };
        return new Response(JSON.stringify(body), {
            status: init.method === "POST" ? 202 : 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    return { calls, fetch };
}

const email = { from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hi" };

describe("sending and management keys", () => {
    test("sends with the sending key and uses the management key for everything else", async () => {
        const { calls, fetch } = keyRecorder();
        const client = new Prontuno({ sendingKey: "send", managementKey: "manage", fetch });

        await client.emails.send(email);
        await client.emails.sendBatch([email]);
        await client.emails.list();
        await client.domains.list();

        assert.deepEqual(calls, [
            { line: "POST /emails", key: "Bearer send" },
            { line: "POST /emails/batch", key: "Bearer send" },
            { line: "GET /emails", key: "Bearer manage" },
            { line: "GET /domains", key: "Bearer manage" },
        ]);
    });

    test("uses a single apiKey for every request", async () => {
        const { calls, fetch } = keyRecorder();
        const client = new Prontuno({ apiKey: " shared ", fetch });

        await client.emails.send(email);
        await client.webhooks.list();

        assert.deepEqual(
            calls.map(({ key }) => key),
            ["Bearer shared", "Bearer shared"],
        );
    });

    test("lets a role-specific key override apiKey", async () => {
        const { calls, fetch } = keyRecorder();
        const client = new Prontuno({ apiKey: "shared", sendingKey: "send", fetch });

        await client.emails.send(email);
        await client.suppressions.list();

        assert.deepEqual(
            calls.map(({ key }) => key),
            ["Bearer send", "Bearer shared"],
        );
    });

    test("fails before any request when the needed key is missing", async () => {
        const { calls, fetch } = keyRecorder();
        const sendOnly = new Prontuno({ sendingKey: "send", fetch });
        const manageOnly = new Prontuno({ managementKey: "manage", fetch });

        await assert.rejects(sendOnly.domains.list(), (error) => {
            assert.ok(error instanceof ProntunoConfigError);
            assert.match(error.message, /GET \/domains requires a management API key/);
            assert.match(error.message, /managementKey/);
            return true;
        });
        await assert.rejects(sendOnly.emails.retrieve("email_1"), /requires a management API key/);
        await assert.rejects(manageOnly.emails.send(email), (error) => {
            assert.ok(error instanceof ProntunoConfigError);
            assert.match(
                error.message,
                /POST \/emails requires a sending API key; pass sendingKey/,
            );
            return true;
        });
        assert.equal(calls.length, 0);
    });

    test("treats blank keys as unset and requires at least one key", async () => {
        const { calls, fetch } = keyRecorder();
        const client = new Prontuno({
            apiKey: "",
            sendingKey: "  ",
            managementKey: "manage",
            fetch,
        });

        await assert.rejects(client.emails.send(email), /requires a sending API key/);
        await client.domains.list();
        assert.equal(calls[0].key, "Bearer manage");

        for (const options of [{}, { sendingKey: " ", managementKey: undefined }]) {
            assert.throws(() => new Prontuno(options), /apiKey, sendingKey, or managementKey/);
        }
    });

    test("withSendingKey switches the sending key and keeps everything else", async () => {
        const { calls, fetch } = keyRecorder();
        const client = new Prontuno({ sendingKey: "send-a", managementKey: "manage", fetch });
        const otherDomain = client.withSendingKey("send-b");

        await otherDomain.emails.send(email);
        await otherDomain.domains.list();
        await client.emails.send(email);

        assert.deepEqual(
            calls.map(({ key }) => key),
            ["Bearer send-b", "Bearer manage", "Bearer send-a"],
        );
        assert.notEqual(otherDomain, client);
        assert.throws(() => client.withSendingKey(" "), ProntunoConfigError);
        assert.throws(() => client.withSendingKey(undefined), ProntunoConfigError);
    });

    test("withSendingKey on a single-key client keeps that key for management", async () => {
        const { calls, fetch } = keyRecorder();
        const client = new Prontuno({ apiKey: "shared", fetch }).withSendingKey("send");

        await client.emails.send(email);
        await client.domains.list();

        assert.deepEqual(
            calls.map(({ key }) => key),
            ["Bearer send", "Bearer shared"],
        );
    });
});
