# Prontuno Node.js SDK

Typed Node.js client for the [Prontuno API](https://prontuno.com/api-reference/general/introduction/). It supports email delivery, sending domains, suppressions, webhook endpoints, API keys, SMTP credentials, cursor pagination, and signed webhook events.

## Installation

```bash
npm install prontuno
```

Node.js 22 or newer is required. Node.js 24 LTS is recommended for production.

The SDK has no runtime dependencies. It uses the runtime's `fetch`, plus `node:crypto` and `node:buffer` for webhook signatures and attachments.

| Runtime                | Support                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| Node.js 22+            | Supported                                                                                       |
| Bun                    | Supported: `bun add prontuno`                                                                   |
| Deno 2 and Deno Deploy | Supported: `import { Prontuno } from "npm:prontuno"`                                            |
| Cloudflare Workers     | Supported with Node.js compatibility (see below)                                                |
| Vercel Functions       | Supported on the Node.js runtime. Not supported on the Edge runtime, which has no `node:crypto` |

### Cloudflare Workers

The SDK needs Workers' Node.js compatibility. It's on by default with a compatibility date of 2026-08-04 or later:

```toml
# wrangler.toml
compatibility_date = "2026-08-04" # or later
```

With an earlier date, turn it on with the `nodejs_compat` flag:

```toml
compatibility_date = "2024-09-23" # or later
compatibility_flags = ["nodejs_compat"]
```

Without Node.js compatibility, the Worker fails when it imports the SDK, even if it only sends email.

Pass keys from the `env` binding, and store them with `wrangler secret put PRONTUNO_SENDING_KEY`. Workers only copies vars and secrets into `process.env` with a compatibility date of 2025-04-01 or later, so with an older date also pass `baseUrl` if you change the API endpoint, because `PRONTUNO_BASE_URL` won't be read:

```ts
import {
    constructWebhookEvent,
    Prontuno,
    WebhookPayloadError,
    WebhookSignatureVerificationError,
} from "prontuno";

interface Env {
    PRONTUNO_SENDING_KEY: string;
    PRONTUNO_WEBHOOK_SIGNING_SECRET: string;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (request.method === "POST" && url.pathname === "/webhooks/prontuno") {
            try {
                // Verify the raw body text before parsing it.
                const event = constructWebhookEvent(
                    await request.text(),
                    request.headers.get("Prontuno-Signature") ?? "",
                    env.PRONTUNO_WEBHOOK_SIGNING_SECRET,
                );
                console.log(event.type, event.event_id);
                return new Response(null, { status: 204 });
            } catch (error) {
                if (
                    error instanceof WebhookSignatureVerificationError ||
                    error instanceof WebhookPayloadError
                ) {
                    return new Response("Invalid webhook", { status: 400 });
                }
                throw error;
            }
        }

        const prontuno = new Prontuno({ sendingKey: env.PRONTUNO_SENDING_KEY });
        const result = await prontuno.emails.send(
            {
                from: "Acme <hello@mg.example.com>",
                to: "ada@example.com",
                subject: "Hello from a Worker",
                text: "Sent with the Prontuno Node.js SDK.",
            },
            { idempotencyKey: crypto.randomUUID() },
        );

        return Response.json(result.emails);
    },
};
```

Only CPU time counts toward a Worker's limit, so time spent waiting on the API and between retries is free. Base64-encoding attachments is the main CPU cost, so large attachments can approach the 10 ms limit on the Workers Free plan.

## Quick start

Prontuno has two kinds of API key: a **sending key**, which can only send email from one verified domain, and a **management key**, which can do everything else. Give the client both and it uses the right one for each call:

```ts
import { Prontuno } from "prontuno";

const prontuno = new Prontuno({
    sendingKey: process.env.PRONTUNO_SENDING_KEY, // emails.send() and emails.sendBatch()
    managementKey: process.env.PRONTUNO_MANAGEMENT_KEY, // everything else
});

const result = await prontuno.emails.send(
    {
        from: "Acme <hello@mg.example.com>",
        to: "ada@example.com",
        subject: "Welcome to Acme",
        html: "<h1>Welcome!</h1>",
    },
    { idempotencyKey: crypto.randomUUID() },
);

console.log(result.emails);
```

The SDK uses the API's snake_case field names so request and response objects match the Prontuno API directly.

## API keys and routing

| Method                                                             | Key used        |
| ------------------------------------------------------------------ | --------------- |
| `emails.send()`, `emails.sendBatch()`                              | `sendingKey`    |
| Everything else, including `emails.list()` and `emails.retrieve()` | `managementKey` |

- **One key for everything:** `new Prontuno(apiKey)` or `new Prontuno({ apiKey })` uses that key for every request, for example a send-only app with just a sending key. `sendingKey` and `managementKey` take precedence over `apiKey`.
- **Missing keys fail early:** calling a method whose key isn't configured throws a `ProntunoConfigError` before any request is made. A send-only client calling `domains.list()` gets "GET /domains requires a management API key; pass managementKey (or apiKey)" instead of a `403` from the API.
- **Blank keys count as unset**, so an empty environment variable doesn't send an empty `Authorization` header.
- **Several sending domains:** each sending key belongs to one domain. Use `withSendingKey()` to get a client for another domain that keeps all other settings, including the management key:

```ts
const billing = prontuno.withSendingKey(process.env.PRONTUNO_BILLING_SENDING_KEY);
await billing.emails.send({ from: "billing@billing.example.com" /* ... */ });
```

## Configuration

```ts
const prontuno = new Prontuno({
    sendingKey: process.env.PRONTUNO_SENDING_KEY,
    managementKey: process.env.PRONTUNO_MANAGEMENT_KEY,
    baseUrl: "https://api.prontuno.net/v1",
    timeout: 30_000,
    maxRetries: 2,
    maxResponseSize: 10 * 1024 * 1024,
    appInfo: "my-app/1.2.0",
});
```

`appInfo` identifies your application in Prontuno's logs. It's added after the SDK's own User-Agent, so requests are sent as `prontuno-node/0.2.0 my-app/1.2.0`.

The base URL defaults to `https://api.prontuno.net/v1`. To point every client at a different endpoint without code changes, set `PRONTUNO_BASE_URL` in the environment; an explicit `baseUrl` option takes precedence, and a blank value falls back to the default.

Custom API endpoints must use HTTPS.

GET and DELETE requests are retried for transient responses, network errors, and timeouts. POST send requests are retried only when an `idempotencyKey` is present; other POST and PATCH requests are never automatically retried. The timeout applies to each attempt, so waiting between retries doesn't count against it; `Retry-After` is honoured up to 60 seconds. If a DELETE is retried after an attempt whose outcome is unknown (a network error, timeout, or `5xx`) and the retry finds the resource already gone (`404`, or `409 already_revoked`), the call succeeds. Identifiers are checked before any request, so an empty ID rejects with a `ProntunoConfigError`. Responses are limited to 10 MiB by default; use `maxResponseSize` to choose a different positive byte limit.

The metadata for the most recently completed response is available on `prontuno.lastResponse`, including the request ID and rate-limit values.

## Emails

### Send one email

```ts
await prontuno.emails.send({
    from: "Acme <hello@mg.example.com>",
    to: ["ada@example.com", "grace@example.com"],
    cc: "team@example.com",
    reply_to: "support@example.com",
    subject: "Your report",
    text: "The report is attached.",
    attachments: [
        {
            filename: "report.pdf",
            content: reportBuffer,
            content_type: "application/pdf",
        },
    ],
});
```

`Buffer` and other `Uint8Array` attachment content is automatically base64-encoded. String content is read as base64 unless you set `encoding`, so pass `encoding: "utf8"` for plain text. Every email needs a `text` body, an `html` body, or both. Each email can have up to 100 recipients across `to`, `cc`, and `bcc`, and must be 25 MB or less once encoded with its attachments (larger emails are rejected with `413 message_too_large`). A batch holds up to 1,000 emails; if any item is invalid, nothing is sent.

### Send a batch

```ts
await prontuno.emails.sendBatch(
    [
        { from: "hello@mg.example.com", to: "ada@example.com", subject: "Hello", text: "Hi Ada" },
        {
            from: "hello@mg.example.com",
            to: "grace@example.com",
            subject: "Hello",
            text: "Hi Grace",
        },
    ],
    { idempotencyKey: crypto.randomUUID() },
);
```

### Retrieve and list

```ts
const email = await prontuno.emails.retrieve("email_01kx...");
console.log(email.status, email.text, email.html); // bodies are null when absent or unavailable

const page = await prontuno.emails.list({
    limit: 50,
    status: "delivered",
    domain_id: "dom_01kx...",
});

for await (const email of prontuno.emails.listAll({ status: "bounced" })) {
    console.log(email.id, email.rejection_reason);
}
```

Automatic pagination rejects repeated cursors and inconsistent pagination metadata. It reads at
most 1,000 pages by default; set `maxPages` on `listAll` options to choose a different positive
limit.

`retrieve()` returns the full email, including its stored `text` and `html` bodies and its `attachments`. List results contain only the status and metadata, so call `retrieve()` when you need the content.

### Attachments

Attachments on a sent email come with a short-lived signed `download_url` that is valid for one hour, until `expires_at`. Both are `null` while a file hasn't finished uploading, and `emails.attachments.retrieve()` rejects with a `403 attachment_unavailable` until it has.

```ts
const page = await prontuno.emails.attachments.list("email_01kx...", { limit: 20 });

for await (const attachment of prontuno.emails.attachments.listAll("email_01kx...")) {
    console.log(attachment.filename, attachment.size, attachment.download_url);
}

// Fetch a fresh link for one attachment, then download it.
const attachment = await prontuno.emails.attachments.retrieve("email_01kx...", "att_01kx...");
if (attachment.download_url) {
    const file = Buffer.from(await (await fetch(attachment.download_url)).arrayBuffer());
}
```

Download links expire, so request a fresh one with `emails.attachments.retrieve()` (or `emails.retrieve()`) instead of storing them. Treat `download_url` as opaque: it may be served from Prontuno's CDN or directly from storage, so don't parse it or depend on its host or path. Fetch it directly, without your API key. The file downloads under its original filename. `content_disposition` (`inline` or `attachment`) describes how the file was attached to the email, not how the link is served. A temporary storage outage returns a retryable `503 storage_unavailable`, which the SDK retries automatically.

## Domains

```ts
const domain = await prontuno.domains.create({ domain: "mg.example.com" });
console.log(domain.dns_records);

const current = await prontuno.domains.retrieve(domain.id);
const page = await prontuno.domains.list({ limit: 50 });

for await (const domain of prontuno.domains.listAll()) {
    console.log(domain.domain, domain.is_verified);
}
```

## Suppressions

```ts
const suppression = await prontuno.suppressions.create({ email: "user@example.com" });

await prontuno.suppressions.retrieve(suppression.id);
await prontuno.suppressions.retrieve("user@example.com");
await prontuno.suppressions.delete(suppression.id);

for await (const suppression of prontuno.suppressions.listAll()) {
    console.log(suppression.email, suppression.type);
}
```

Only manual suppressions can be deleted through the API.

## Webhook endpoints

```ts
const webhook = await prontuno.webhooks.create({
    name: "Production app",
    url: "https://example.com/webhooks/prontuno",
    events: ["email.delivered", "email.bounced", "email.complained"],
    // Omit domain_id for a team-wide webhook, or scope it to one verified domain:
    // domain_id: "dom_01kx...",
});

// The signing secret is returned only once. Store it securely.
console.log(webhook.secret);

await prontuno.webhooks.retrieve(webhook.id);
await prontuno.webhooks.update(webhook.id, { is_enabled: false });
// Switching scope needs is_global as well as domain_id:
await prontuno.webhooks.update(webhook.id, { is_global: false, domain_id: "dom_01kx..." });

const { secret } = await prontuno.webhooks.rotateSecret(webhook.id);

for await (const item of prontuno.webhooks.listAll()) {
    console.log(item.name, item.events);
}

await prontuno.webhooks.delete(webhook.id);
```

### Event types

| Event              | Sent when                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `email.sent`       | Prontuno's outbound mail server accepted the email for delivery.                                            |
| `email.delivered`  | The recipient's mail server accepted the email.                                                             |
| `email.deferred`   | The recipient's mail server temporarily refused the email. Delivery is retried.                             |
| `email.bounced`    | The recipient's mail server permanently refused the email.                                                  |
| `email.expired`    | Delivery was retried until the retry period ran out without success.                                        |
| `email.rejected`   | Prontuno refused the email before sending it, for example because the recipient is on the suppression list. |
| `email.complained` | The recipient reported the email as spam to their mailbox provider.                                         |

Subscribe to any combination with `events`. Each event's `data` describes the email it relates to.

Rotating a secret invalidates the previous one immediately, so update your receiver right away.

## API keys

Managing API keys requires a `management` API key.

```ts
// Key permissions (scopes) come from its type and can't be chosen individually.
const sendingKey = await prontuno.apiKeys.create({
    name: "Production sender",
    type: "sending", // email:send from one verified domain
    domain_id: "dom_01kx...",
});

// The plaintext key is returned only once. Store it securely.
console.log(sendingKey.key);

await prontuno.apiKeys.create({ name: "Support agent", type: "mcp" });
await prontuno.apiKeys.create({
    name: "Agent that sends",
    type: "mcp",
    allow_email_sending: true,
    domain_id: "dom_01kx...",
});
await prontuno.apiKeys.create({ name: "Ops automation", type: "management" });

await prontuno.apiKeys.retrieve(sendingKey.id); // includes revoked keys

for await (const key of prontuno.apiKeys.listAll({ status: "all", type: "sending" })) {
    console.log(key.name, key.status, key.last_used_at);
}

// Requests using a revoked key fail immediately. Revoking twice returns 409 already_revoked.
await prontuno.apiKeys.revoke(sendingKey.id);
```

| Type         | Scopes                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sending`    | `email:send` for one verified domain (`domain_id` required)                                                                                                    |
| `mcp`        | `domains:*`, `emails:read`, `inbound:read`, `suppressions:*`, `usage:read`, `webhooks:*`, plus `email:send` with `allow_email_sending: true` and a `domain_id` |
| `management` | The `mcp` account scopes without `email:send`, plus `api_keys:*` and `smtp_credentials:*`                                                                      |

`list` and `listAll` return active keys by default; pass `status: "revoked"` or `"all"` to include others.

## SMTP credentials

```ts
const credential = await prontuno.smtpCredentials.create({
    name: "Legacy CRM",
    domain_id: "dom_01kx...",
});

// Use these as the SMTP login. The password is returned only once.
console.log(credential.username, credential.password);

const { password } = await prontuno.smtpCredentials.resetPassword(credential.id); // old password stops working

await prontuno.smtpCredentials.retrieve(credential.id);
for await (const item of prontuno.smtpCredentials.listAll({ status: "all" })) {
    console.log(item.username, item.status);
}

await prontuno.smtpCredentials.revoke(credential.id); // SMTP logins fail immediately
```

Creating API keys and SMTP credentials, and resetting passwords, are never retried automatically, so a timeout can't create a duplicate secret.

## Usage

```ts
const usage = await prontuno.usage.retrieve();

if (usage.subscription?.is_active) {
    console.log(usage.subscription.recipients_remaining); // null on the unlimited plan
}
console.log(usage.credits.balance); // prepaid credits; one covers one recipient
console.log(usage.limits.domains); // { used: 12, limit: 1000 }, limit is null when unlimited
```

Sends draw on the subscription allowance first while it's active, then on prepaid credits. `subscription` is `null` when the team has no plan, and `recipients_remaining` is `0` while the subscription isn't active.

## Errors

```ts
import { ProntunoApiError } from "prontuno";

try {
    await prontuno.emails.retrieve("email_missing");
} catch (error) {
    if (error instanceof ProntunoApiError) {
        console.error(error.status); // 404
        console.error(error.code); // "not_found"
        console.error(error.requestId); // x-request-id
        console.error(error.retryable);
        console.error(error.suggestedAction);
        console.error(error.details); // validation/batch details, when present
        console.error(error.retryAfter); // seconds, when the API sends Retry-After
        console.error(error.rateLimit);
    }
}
```

The SDK also exports `ProntunoConfigError`, `ProntunoConnectionError`, and `ProntunoTimeoutError`.

## Webhooks

Prontuno signs the exact raw request body with HMAC-SHA256. Do not parse and re-serialize the body before verification.

```ts
import { constructWebhookEvent } from "prontuno";

const webhookSecret = process.env.PRONTUNO_WEBHOOK_SIGNING_SECRET?.trim();
if (!webhookSecret) {
    throw new Error("PRONTUNO_WEBHOOK_SIGNING_SECRET is required");
}

// Express example. Configure this route to receive a raw body.
app.post("/webhooks/prontuno", express.raw({ type: "application/json" }), (req, res) => {
    const event = constructWebhookEvent(
        req.body,
        req.header("Prontuno-Signature") ?? "",
        webhookSecret,
    );

    switch (event.type) {
        case "email.delivered":
            console.log(event.data.email_id, event.data.delivered_at);
            break;
        case "email.bounced":
            console.log(event.data.reason, event.data.bounce.type);
            break;
        case "email.complained":
            console.log("Recipient marked the email as spam", event.data.to_email);
            break;
        default:
            // Event types added after this SDK version arrive here; acknowledge them.
            break;
    }

    res.sendStatus(204);
});
```

The default timestamp tolerance is five minutes. Pass `{ tolerance: 0 }` to skip the timestamp check. To verify without parsing, call `verifyWebhookSignature(rawBody, signature, secret)` or `prontuno.webhooks.verifySignature(...)`. The standalone helpers don't need an API key.

Webhook requests include these useful headers:

- `Prontuno-Event`
- `Prontuno-Event-Id`
- `Prontuno-Webhook-Id`
- `Prontuno-Signature` (`t=<unix-seconds>,v1=<hex-hmac>`)
- `Prontuno-Delivery-Attempt`
- `Idempotency-Key` (the event ID)

See [Event types](#event-types) for every event and when it's sent.

Respond with any `2xx` status after processing. Use the event ID to make your handler idempotent because deliveries can be retried.

## Request options

Every resource method accepts per-request options such as an abort signal, timeout, retry count, and extra headers:

```ts
await prontuno.emails.retrieve("email_01kx...", {
    signal: AbortSignal.timeout(5_000),
    timeout: 10_000,
    maxRetries: 1,
    maxResponseSize: 2 * 1024 * 1024,
    headers: { "x-correlation-id": "job_123" },
});
```

## License

The Prontuno Node.js SDK is open-sourced software licensed under the [MIT license](LICENSE.md).
