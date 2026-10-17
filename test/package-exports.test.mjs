import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import ProntunoDefault, { Prontuno, verifyWebhookSignature } from "prontuno";

test("published ESM and CommonJS exports work", async () => {
    assert.equal(
        ProntunoDefault,
        Prontuno,
        "The ESM default and named client exports should match",
    );
    assert.equal(
        typeof verifyWebhookSignature,
        "function",
        "The ESM webhook helper should be exported",
    );

    const require = createRequire(import.meta.url);
    const commonJs = require("prontuno");

    assert.equal(
        commonJs.default,
        commonJs.Prontuno,
        "The CommonJS default and named client exports should match",
    );
    assert.equal(
        typeof commonJs.verifyWebhookSignature,
        "function",
        "The CommonJS webhook helper should be exported",
    );

    const client = new Prontuno({
        apiKey: "pno_sk_test",
        baseUrl: "https://example.test/v1",
        maxRetries: 0,
        fetch: async () =>
            new Response(
                JSON.stringify({
                    id: "email_test",
                    domain_id: null,
                    from: "sender@example.com",
                    to: "recipient@example.com",
                    subject: "Runtime smoke test",
                    recipient_type: "to",
                    status: "delivered",
                    rejection_code: null,
                    rejection_reason: null,
                    sent_at: null,
                    delivered_at: null,
                    bounced_at: null,
                    deferred_at: null,
                    expired_at: null,
                    rejected_at: null,
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
            ),
    });

    const email = await client.emails.retrieve("email_test");
    assert.equal(
        email.id,
        "email_test",
        "The built client should execute on the selected Node.js version",
    );
});
