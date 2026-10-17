import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Prontuno, ProntunoApiError } from "prontuno";

function recordingClient(responses, options = {}) {
    const calls = [];
    const fetch = async (input, init) => {
        calls.push({
            url: String(input),
            method: init.method,
            key: init.headers.get("Authorization"),
        });
        const next = responses.shift();
        return new Response(JSON.stringify(next.body), {
            status: next.status ?? 200,
            headers: { "Content-Type": "application/json", ...next.headers },
        });
    };
    return {
        calls,
        client: new Prontuno({ sendingKey: "send", managementKey: "manage", fetch, ...options }),
    };
}

const attachment = {
    id: "att_01kfzeb03ae59a98z11nhxnrkp",
    filename: "invoice.pdf",
    content_type: "application/pdf",
    size: 48213,
    sha256: "a".repeat(64),
    content_id: null,
    content_disposition: "attachment",
    // Opaque CDN link: the storage key is the attachment ID, never the filename.
    download_url:
        "https://files.example.com/sent/2026/10/18/att_01kfzeb03ae59a98z11nhxnrkp?token=HS256-abc&expires=1792328400",
    expires_at: "2026-10-18T13:00:00.000Z",
};

const pending = {
    ...attachment,
    id: "att_01kfzeb03ae59a98z11nhxnrkq",
    download_url: null,
    expires_at: null,
};

describe("email details", () => {
    test("retrieves an email with its bodies and attachments using the management key", async () => {
        const { calls, client } = recordingClient([
            {
                body: {
                    id: "email_1",
                    status: "delivered",
                    text: "Your invoice is attached.",
                    html: null,
                    attachments: [attachment],
                },
            },
        ]);

        const email = await client.emails.retrieve("email_1");

        assert.equal(email.text, "Your invoice is attached.");
        assert.equal(email.html, null);
        assert.equal(email.attachments[0].download_url, attachment.download_url);
        assert.deepEqual(calls, [
            {
                url: "https://api.prontuno.net/v1/emails/email_1",
                method: "GET",
                key: "Bearer manage",
            },
        ]);
    });
});

describe("email attachments", () => {
    test("lists one page of attachments", async () => {
        const { calls, client } = recordingClient([
            {
                body: {
                    data: [attachment, pending],
                    pagination: { limit: 2, has_more: false, next_cursor: null },
                },
            },
        ]);

        const page = await client.emails.attachments.list("email_1", { limit: 2, cursor: "c1" });

        assert.deepEqual(
            page.data.map((item) => item.download_url),
            [attachment.download_url, null],
        );
        assert.equal(
            calls[0].url,
            "https://api.prontuno.net/v1/emails/email_1/attachments?limit=2&cursor=c1",
        );
        assert.equal(calls[0].key, "Bearer manage");
    });

    test("iterates attachments across pages", async () => {
        const { calls, client } = recordingClient([
            {
                body: {
                    data: [attachment],
                    pagination: { limit: 1, has_more: true, next_cursor: "c2" },
                },
            },
            {
                body: {
                    data: [pending],
                    pagination: { limit: 1, has_more: false, next_cursor: null },
                },
            },
        ]);

        const ids = [];
        for await (const item of client.emails.attachments.listAll("email_1", { limit: 1 })) {
            ids.push(item.id);
        }

        assert.deepEqual(ids, [attachment.id, pending.id]);
        assert.equal(
            calls[1].url,
            "https://api.prontuno.net/v1/emails/email_1/attachments?limit=1&cursor=c2",
        );
    });

    test("stops on a repeated attachment cursor", async () => {
        const repeat = {
            body: { data: [], pagination: { limit: 1, has_more: true, next_cursor: "same" } },
        };
        const { client } = recordingClient([repeat, repeat]);

        await assert.rejects(
            Array.fromAsync(client.emails.attachments.listAll("email_1")),
            /repeated pagination cursor/,
        );
    });

    test("retrieves one attachment and encodes identifiers", async () => {
        const { calls, client } = recordingClient([{ body: attachment }]);

        const result = await client.emails.attachments.retrieve("email_1", "att_01/x");

        assert.equal(result.sha256, attachment.sha256);
        assert.equal(
            calls[0].url,
            "https://api.prontuno.net/v1/emails/email_1/attachments/att_01%2Fx",
        );
    });

    test("retries temporary storage outages", async () => {
        const { calls, client } = recordingClient([
            {
                status: 503,
                headers: { "Retry-After": "0" },
                body: {
                    error: {
                        code: "storage_unavailable",
                        message: "The email content is temporarily unavailable",
                        retryable: true,
                        suggested_action: "retry_later",
                    },
                },
            },
            { body: attachment },
        ]);

        assert.equal(
            (await client.emails.attachments.retrieve("email_1", attachment.id)).id,
            attachment.id,
        );
        assert.equal(calls.length, 2);
    });

    test("surfaces attachments that haven't finished uploading without retrying", async () => {
        const { calls, client } = recordingClient([
            {
                status: 403,
                body: {
                    error: {
                        code: "attachment_unavailable",
                        message: "This attachment is unavailable because its storage is incomplete",
                        retryable: false,
                        suggested_action: "contact_support",
                    },
                },
            },
        ]);

        const error = await client.emails.attachments
            .retrieve("email_1", pending.id)
            .catch((caught) => caught);
        assert.ok(error instanceof ProntunoApiError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "attachment_unavailable");
        assert.equal(error.retryable, false);
        assert.equal(calls.length, 1);
    });

    test("requires the management key", async () => {
        const client = new Prontuno({ sendingKey: "send", fetch: async () => new Response("{}") });

        await assert.rejects(
            client.emails.attachments.list("email_1"),
            /GET \/emails\/email_1\/attachments requires a management API key/,
        );
    });
});
