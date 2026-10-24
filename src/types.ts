export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
    /** One key for every request. `sendingKey` and `managementKey` take precedence over it. */
    apiKey?: string | undefined;
    /** Domain-bound sending key, used for `emails.send()` and `emails.sendBatch()`. */
    sendingKey?: string | undefined;
    /** Management key, used for every other request. */
    managementKey?: string | undefined;
    baseUrl?: string;
    timeout?: number;
    maxRetries?: number;
    maxResponseSize?: number;
    fetch?: Fetch;
    /**
     * Identifies your application in Prontuno's logs, for example `"my-app/1.2.0"`. It is
     * added after the SDK's own `prontuno-node/<version>` User-Agent, never instead of it.
     */
    appInfo?: string;
}

export interface RequestOptions {
    signal?: AbortSignal;
    timeout?: number;
    maxRetries?: number;
    maxResponseSize?: number;
    headers?: Record<string, string>;
}

export interface IdempotentRequestOptions extends RequestOptions {
    idempotencyKey?: string;
}

export type Recipient = string | string[];
export type HeaderValue = string | number | boolean | null;
export type EmailHeaders = Record<string, HeaderValue>;
export type AttachmentEncoding = "base64" | "utf8" | "ascii" | "latin1" | "hex";

export interface AttachmentInput {
    filename: string;
    /**
     * Raw bytes, or a string in `encoding`. Strings are read as base64 unless `encoding`
     * says otherwise, so pass `encoding: "utf8"` for plain text.
     */
    content: string | Uint8Array;
    encoding?: AttachmentEncoding;
    content_type?: string;
    content_id?: string;
}

interface EmailInputFields {
    from: string;
    to: Recipient;
    cc?: Recipient;
    bcc?: Recipient;
    subject: string;
    reply_to?: string;
    headers?: EmailHeaders;
    attachments?: AttachmentInput[];
}

/** An email needs a `text` body, an `html` body, or both. */
export type EmailInput = EmailInputFields &
    ({ text: string; html?: string } | { text?: string; html: string });

export interface AcceptedEmail {
    id: string;
    to: string;
    status: "queued" | "rejected";
    rejection_code: string | null;
    rejection_reason: string | null;
}

export interface SendEmailResponse {
    emails: AcceptedEmail[];
}

export interface SendBatchResponse {
    emails: AcceptedEmail[][];
}

export type EmailStatus =
    | "queued"
    | "sent"
    | "deferred"
    | "delivered"
    | "bounced"
    | "expired"
    | "rejected"
    | "complained";

export type RecipientType = "to" | "cc" | "bcc";

export interface Email {
    id: string;
    domain_id: string | null;
    from: string | null;
    to: string | null;
    subject: string | null;
    recipient_type: RecipientType;
    status: EmailStatus;
    rejection_code: string | null;
    rejection_reason: string | null;
    sent_at: string | null;
    delivered_at: string | null;
    bounced_at: string | null;
    deferred_at: string | null;
    expired_at: string | null;
    rejected_at: string | null;
}

export interface SentEmailAttachment {
    id: string;
    filename: string | null;
    content_type: string;
    size: number | null;
    /** SHA-256 hex digest, or null for attachments stored before hashes were recorded. */
    sha256: string | null;
    content_id: string | null;
    /** How the file was attached to the email (`inline` or `attachment`), not how the link is served. */
    content_disposition: string;
    /**
     * Short-lived signed download link, valid until `expires_at`, or null while the file
     * hasn't finished uploading. Treat it as opaque: it may be served from a CDN or directly
     * from storage, so don't parse it or depend on its host or path.
     */
    download_url: string | null;
    /** When `download_url` stops working, one hour after the response, or null with it. */
    expires_at: string | null;
}

/** A single email as returned by `emails.retrieve()`, including its content. */
export interface EmailDetails extends Email {
    /** Stored plain-text body, or null when absent or unavailable. */
    text: string | null;
    /** Stored HTML body, or null when absent or unavailable. */
    html: string | null;
    attachments: SentEmailAttachment[];
}

export interface CursorPagination {
    limit: number;
    has_more: boolean;
    next_cursor: string | null;
}

export interface ListResponse<T> {
    data: T[];
    pagination: CursorPagination;
}

export interface ListOptions extends RequestOptions {
    limit?: number;
    cursor?: string;
    maxPages?: number;
}

export interface EmailListOptions extends ListOptions {
    domain_id?: string;
    status?: EmailStatus;
}

export interface DnsRecord {
    status: "pending" | "verified";
    record_type: "CNAME" | "TXT";
    hostname: string;
    value: string;
    ttl: number;
}

export interface Domain {
    id: string;
    domain: string;
    is_verified: boolean;
    is_disabled: boolean;
    disabled_reason: string | null;
    created_at: string | null;
}

export interface DomainDetails extends Domain {
    dns_records: DnsRecord[];
}

export interface CreateDomainInput {
    domain: string;
}

export interface Suppression {
    id: string;
    email: string;
    type: string | null;
    suppressed_at: string | null;
}

export interface CreateSuppressionInput {
    email: string;
}

export interface SuppressionListOptions extends ListOptions {
    email?: string;
}

export interface Webhook {
    id: string;
    name: string;
    url: string;
    events: WebhookEventType[];
    domain_id: string | null;
    is_global: boolean;
    is_enabled: boolean;
    created_at: string;
}

export interface WebhookWithSecret extends Webhook {
    secret: string;
}

export interface WebhookSecret {
    id: string;
    secret: string;
}

export interface CreateWebhookInput {
    name: string;
    url: string;
    events: WebhookEventType[];
    domain_id?: string | null;
    is_global?: boolean;
    is_enabled?: boolean;
}

/**
 * To switch between all domains and one domain, set `is_global` too:
 * `{ is_global: true, domain_id: null }` or `{ is_global: false, domain_id: "dom_..." }`.
 */
export type UpdateWebhookInput = Partial<CreateWebhookInput>;

export type ApiKeyType = "sending" | "receiving" | "mcp" | "management";
export type CredentialStatus = "active" | "revoked" | "disabled";
export type CredentialStatusFilter = "active" | "revoked" | "all";

export interface ApiKey {
    id: string;
    name: string;
    type: ApiKeyType;
    scopes: string[];
    domain_id: string | null;
    domain: string | null;
    status: CredentialStatus;
    created_via: string | null;
    created_at: string;
    last_used_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
}

export interface ApiKeyWithSecret extends ApiKey {
    key: string;
}

/**
 * Scopes are derived from `type`: `sending` keys send from one domain, `mcp` keys
 * manage the account (and may also send), and `management` keys can also manage
 * API keys and SMTP credentials.
 */
export type CreateApiKeyInput =
    | { name: string; type: "sending"; domain_id: string }
    | { name: string; type: "mcp"; allow_email_sending?: false }
    | { name: string; type: "mcp"; allow_email_sending: true; domain_id: string }
    | { name: string; type: "management" };

export interface ApiKeyListOptions extends ListOptions {
    status?: CredentialStatusFilter;
    type?: ApiKeyType;
}

export interface SmtpCredential {
    id: string;
    name: string;
    domain_id: string | null;
    domain: string | null;
    username: string;
    status: CredentialStatus;
    created_via: string | null;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
}

export interface SmtpCredentialWithPassword extends SmtpCredential {
    password: string;
}

export interface CreateSmtpCredentialInput {
    name: string;
    domain_id: string;
}

export interface SmtpCredentialListOptions extends ListOptions {
    status?: CredentialStatusFilter;
}

export type SubscriptionPlan = "standard" | "plus" | "unlimited";

export interface UsageSubscription {
    plan: SubscriptionPlan;
    /** Billing status, such as `active`, `past_due`, or `canceled`. */
    status: string | null;
    /** Whether sends currently draw on this plan's allowance. */
    is_active: boolean;
    period_start: string | null;
    /** When the allowance resets. */
    period_end: string | null;
    cancel_at_period_end: boolean;
    /** `null` on the unlimited plan. */
    recipients_included: number | null;
    recipients_used: number;
    /** `0` while the subscription isn't active and `null` on the unlimited plan. */
    recipients_remaining: number | null;
}

export interface UsageLimit {
    used: number;
    /** `null` when unlimited. */
    limit: number | null;
}

export interface Usage {
    /** `null` when the team has no plan. */
    subscription: UsageSubscription | null;
    credits: {
        /** Prepaid credits available. One credit covers one recipient. */
        balance: number;
        expires_at: string | null;
    };
    limits: {
        domains: UsageLimit;
        /** Shared teams owned by the API key's owner; `null` when the key has no owning user. */
        shared_teams: UsageLimit | null;
        api_keys: UsageLimit;
        smtp_credentials: UsageLimit;
    };
}

export type SuggestedAction =
    | "fix_input"
    | "retry_later"
    | "contact_support"
    | "reauthenticate"
    | "check_permissions"
    | "check_server_configuration"
    | "check_endpoint"
    | "use_new_idempotency_key"
    | "top_up_credits";

export interface ApiErrorDetail {
    code: string;
    message: string;
    field?: string;
    value?: unknown;
    path?: string;
    detail?: string;
    retryable?: boolean;
    suggested_action?: SuggestedAction;
    retry_after_seconds?: number;
    retry_strategy?: "exponential_backoff";
    available_credits?: number;
    meta?: Record<string, unknown>;
}

export interface BatchValidationError {
    index: number;
    errors: ApiErrorDetail[];
}

export interface ApiErrorBody {
    error?: ApiErrorDetail;
    errors?: Array<ApiErrorDetail | BatchValidationError>;
    total?: number;
    failed?: number;
    [key: string]: unknown;
}

export interface RateLimit {
    limit: number | null;
    remaining: number | null;
    reset: number | null;
}

export type WebhookEventType =
    | "email.sent"
    | "email.rejected"
    | "email.deferred"
    | "email.delivered"
    | "email.bounced"
    | "email.expired"
    | "email.complained";

export interface WebhookEmailData {
    email_id: string;
    domain_id: string | null;
    message_id: string | null;
    subject: string | null;
    from_email: string | null;
    from_name: string;
    to_email: string | null;
    recipient_type: RecipientType;
    domain: string | null;
}

export interface EmailSentData extends WebhookEmailData {
    sent_at: string | null;
}

export interface EmailDeliveredData extends WebhookEmailData {
    sent_at: string | null;
    delivered_at: string | null;
}

export interface EmailDeferredData extends WebhookEmailData {
    sent_at: string | null;
    deferred_at: string | null;
}

export interface EmailBouncedData extends WebhookEmailData {
    sent_at: string | null;
    bounced_at: string | null;
    reason: string;
    bounce: {
        type: "permanent" | "transient" | "undetermined";
        enhanced_status_code: string | null;
        diagnostic_code: string | null;
    };
}

export interface EmailRejectedData extends WebhookEmailData {
    sent_at: string | null;
    rejected_at: string | null;
    reason_code: string | null;
    reason: string | null;
}

export interface EmailExpiredData extends WebhookEmailData {
    sent_at: string | null;
    expired_at: string | null;
    reason: string;
    [key: string]: unknown;
}

export interface EmailComplainedData extends WebhookEmailData {
    sent_at: string | null;
    complained_at: string | null;
    [key: string]: unknown;
}

export interface WebhookEventBase<TType extends WebhookEventType, TData> {
    event_id: string;
    webhook_id: string;
    type: TType;
    created_at: string;
    data: TData;
}

export type EmailSentEvent = WebhookEventBase<"email.sent", EmailSentData>;
export type EmailRejectedEvent = WebhookEventBase<"email.rejected", EmailRejectedData>;
export type EmailDeferredEvent = WebhookEventBase<"email.deferred", EmailDeferredData>;
export type EmailDeliveredEvent = WebhookEventBase<"email.delivered", EmailDeliveredData>;
export type EmailBouncedEvent = WebhookEventBase<"email.bounced", EmailBouncedData>;
export type EmailExpiredEvent = WebhookEventBase<"email.expired", EmailExpiredData>;
export type EmailComplainedEvent = WebhookEventBase<"email.complained", EmailComplainedData>;

export type WebhookEvent =
    | EmailSentEvent
    | EmailRejectedEvent
    | EmailDeferredEvent
    | EmailDeliveredEvent
    | EmailBouncedEvent
    | EmailExpiredEvent
    | EmailComplainedEvent;

export interface WebhookVerificationOptions {
    /** Maximum signature age in seconds (default 300); 0 disables the check. */
    tolerance?: number;
    now?: number | Date;
}
