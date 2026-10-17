// Compile-time checks for the public types. Run by `npm run typecheck`; never executed.
import {
    Prontuno,
    type AcceptedEmail,
    type ApiKey,
    type ApiKeyType,
    type ApiKeyWithSecret,
    type CreateApiKeyInput,
    type SmtpCredential,
    type SmtpCredentialWithPassword,
    type CreateWebhookInput,
    type Email,
    type EmailDetails,
    type EmailInput,
    type EmailStatus,
    type SentEmailAttachment,
    type UpdateWebhookInput,
    type Webhook,
    type WebhookEvent,
    type WebhookEventType,
    type WebhookSecret,
    type WebhookWithSecret,
} from "../src/index.js";

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<T extends true>(_value?: T): void {}

expectType<
    Equal<
        EmailStatus,
        | "queued"
        | "sent"
        | "deferred"
        | "delivered"
        | "bounced"
        | "expired"
        | "rejected"
        | "complained"
    >
>();
expectType<
    Equal<
        WebhookEventType,
        | "email.sent"
        | "email.rejected"
        | "email.deferred"
        | "email.delivered"
        | "email.bounced"
        | "email.expired"
        | "email.complained"
    >
>();
expectType<Equal<WebhookEvent["type"], WebhookEventType>>();

// Email records carry every delivery timestamp.
expectType<Equal<Email["deferred_at"], string | null>>();
expectType<Equal<Email["expired_at"], string | null>>();

// Send results report each recipient's acceptance status.
expectType<Equal<AcceptedEmail["status"], "queued" | "rejected">>();
expectType<Equal<AcceptedEmail["rejection_code"], string | null>>();

// Inbound is out of scope for this SDK.
// @ts-expect-error email.received is not a supported webhook event
const received: WebhookEventType = "email.received";
// @ts-expect-error emails cannot be filtered by an unknown status
const unknownStatus: EmailStatus = "failed";

// Webhook inputs.
const create: CreateWebhookInput = {
    name: "Production",
    url: "https://example.com/hooks",
    events: ["email.delivered"],
};
// @ts-expect-error name, url, and events are required
const incomplete: CreateWebhookInput = { name: "Production" };
const update: UpdateWebhookInput = { domain_id: null };

declare const client: Prontuno;
async function resourceReturnTypes(): Promise<void> {
    expectType<Equal<Awaited<ReturnType<typeof client.webhooks.create>>, WebhookWithSecret>>();
    expectType<Equal<Awaited<ReturnType<typeof client.webhooks.retrieve>>, Webhook>>();
    expectType<Equal<Awaited<ReturnType<typeof client.webhooks.update>>, Webhook>>();
    expectType<Equal<Awaited<ReturnType<typeof client.webhooks.rotateSecret>>, WebhookSecret>>();
    expectType<Equal<Awaited<ReturnType<typeof client.webhooks.delete>>, void>>();

    for await (const webhook of client.webhooks.listAll()) {
        expectType<Equal<typeof webhook, Webhook>>();
    }

    const event = client.webhooks.constructEvent("", "", "");
    if (event.type === "email.bounced") {
        expectType<
            Equal<typeof event.data.bounce.type, "permanent" | "transient" | "undetermined">
        >();
    }
    if (event.type === "email.expired") {
        expectType<Equal<typeof event.data.expired_at, string | null>>();
    }
    if (event.type === "email.complained") {
        expectType<Equal<typeof event.data.complained_at, string | null>>();
    }
}

// API keys: scopes come from the type, and the domain rules are enforced by the input union.
expectType<Equal<ApiKeyType, "sending" | "receiving" | "mcp" | "management">>();
const sendingKey: CreateApiKeyInput = { name: "App", type: "sending", domain_id: "dom_1" };
const managementKey: CreateApiKeyInput = { name: "Admin", type: "management" };
const mcpKey: CreateApiKeyInput = { name: "Agent", type: "mcp" };
const mcpSendingKey: CreateApiKeyInput = {
    name: "Agent",
    type: "mcp",
    allow_email_sending: true,
    domain_id: "dom_1",
};
// @ts-expect-error sending keys need a domain
const sendingWithoutDomain: CreateApiKeyInput = { name: "App", type: "sending" };
// @ts-expect-error MCP keys that send email need a domain
const mcpSendingWithoutDomain: CreateApiKeyInput = {
    name: "Agent",
    type: "mcp",
    allow_email_sending: true,
};
const managementWithDomain: CreateApiKeyInput = {
    name: "Admin",
    type: "management",
    // @ts-expect-error management keys can't be bound to a domain
    domain_id: "dom_1",
};
// @ts-expect-error receiving (inbound) keys can't be created through this SDK
const receivingKey: CreateApiKeyInput = { name: "Inbox", type: "receiving" };

// Key configuration: one shared key or separate sending and management keys.
const separateKeys = new Prontuno({ sendingKey: "send", managementKey: "manage" });
expectType<Equal<ReturnType<typeof separateKeys.withSendingKey>, Prontuno>>();

// Email details include content; list items don't.
async function emailContentTypes(): Promise<void> {
    expectType<Equal<Awaited<ReturnType<typeof client.emails.retrieve>>, EmailDetails>>();
    expectType<Equal<EmailDetails["text"], string | null>>();
    expectType<Equal<EmailDetails["attachments"], SentEmailAttachment[]>>();
    expectType<Equal<SentEmailAttachment["download_url"], string | null>>();
    expectType<
        Equal<Awaited<ReturnType<typeof client.emails.attachments.retrieve>>, SentEmailAttachment>
    >();
    for await (const item of client.emails.attachments.listAll("email_1")) {
        expectType<Equal<typeof item, SentEmailAttachment>>();
    }
    const listed = await client.emails.list();
    // @ts-expect-error list items don't include bodies
    void listed.data[0]?.html;
    void (null as unknown as Email);
}

async function credentialReturnTypes(): Promise<void> {
    expectType<Equal<Awaited<ReturnType<typeof client.apiKeys.create>>, ApiKeyWithSecret>>();
    expectType<Equal<Awaited<ReturnType<typeof client.apiKeys.retrieve>>, ApiKey>>();
    expectType<Equal<Awaited<ReturnType<typeof client.apiKeys.revoke>>, void>>();
    expectType<
        Equal<Awaited<ReturnType<typeof client.smtpCredentials.create>>, SmtpCredentialWithPassword>
    >();
    expectType<
        Equal<
            Awaited<ReturnType<typeof client.smtpCredentials.resetPassword>>,
            SmtpCredentialWithPassword
        >
    >();
    expectType<
        Equal<Awaited<ReturnType<typeof client.smtpCredentials.retrieve>>, SmtpCredential>
    >();
    // @ts-expect-error SMTP credentials need a domain
    await client.smtpCredentials.create({ name: "App" });
}

void [
    sendingKey,
    managementKey,
    mcpKey,
    mcpSendingKey,
    sendingWithoutDomain,
    mcpSendingWithoutDomain,
    managementWithDomain,
    receivingKey,
    credentialReturnTypes,
    emailContentTypes,
];
void [received, unknownStatus, create, incomplete, update, resourceReturnTypes];

// Emails need a text or HTML body.
const textOnly: EmailInput = {
    from: "a@example.com",
    to: "b@example.com",
    subject: "Hi",
    text: "Hi",
};
const htmlOnly: EmailInput = {
    from: "a@example.com",
    to: "b@example.com",
    subject: "Hi",
    html: "<p>Hi</p>",
};
// @ts-expect-error text or html is required
const noBody: EmailInput = { from: "a@example.com", to: "b@example.com", subject: "Hi" };
void [textOnly, htmlOnly, noBody];
