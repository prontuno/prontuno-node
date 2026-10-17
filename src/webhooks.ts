import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookPayloadError, WebhookSignatureVerificationError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { pathId } from "./paths.js";
import { PaginationGuard } from "./pagination.js";
import type {
    CreateWebhookInput,
    ListOptions,
    ListResponse,
    RequestOptions,
    UpdateWebhookInput,
    Webhook,
    WebhookEvent,
    WebhookSecret,
    WebhookVerificationOptions,
    WebhookWithSecret,
} from "./types.js";

const DEFAULT_TOLERANCE_SECONDS = 300;

export class Webhooks {
    constructor(private readonly client: HttpClient) {}

    create(input: CreateWebhookInput, options: RequestOptions = {}): Promise<WebhookWithSecret> {
        return this.client.request<WebhookWithSecret>("webhooks", {
            ...options,
            method: "POST",
            body: input,
        });
    }

    async retrieve(webhookId: string, options: RequestOptions = {}): Promise<Webhook> {
        return this.client.request<Webhook>(`webhooks/${pathId("webhook", webhookId)}`, options);
    }

    async update(
        webhookId: string,
        input: UpdateWebhookInput,
        options: RequestOptions = {},
    ): Promise<Webhook> {
        return this.client.request<Webhook>(`webhooks/${pathId("webhook", webhookId)}`, {
            ...options,
            method: "PATCH",
            body: input,
        });
    }

    async delete(webhookId: string, options: RequestOptions = {}): Promise<void> {
        return this.client.request<void>(`webhooks/${pathId("webhook", webhookId)}`, {
            ...options,
            method: "DELETE",
        });
    }

    async rotateSecret(webhookId: string, options: RequestOptions = {}): Promise<WebhookSecret> {
        return this.client.request<WebhookSecret>(
            `webhooks/${pathId("webhook", webhookId)}/rotate-secret`,
            { ...options, method: "POST" },
        );
    }

    list(options: ListOptions = {}): Promise<ListResponse<Webhook>> {
        const { limit, cursor, maxPages: _maxPages, ...requestOptions } = options;
        return this.client.request<ListResponse<Webhook>>("webhooks", {
            ...requestOptions,
            query: { limit, cursor },
        });
    }

    async *listAll(options: ListOptions = {}): AsyncGenerator<Webhook, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list({ ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }

    verifySignature(
        rawBody: string | Uint8Array,
        signature: string,
        secret: string,
        options: WebhookVerificationOptions = {},
    ): true {
        return verifyWebhookSignature(rawBody, signature, secret, options);
    }

    constructEvent(
        rawBody: string | Uint8Array,
        signature: string,
        secret: string,
        options: WebhookVerificationOptions = {},
    ): WebhookEvent {
        return constructWebhookEvent(rawBody, signature, secret, options);
    }
}

export function verifyWebhookSignature(
    rawBody: string | Uint8Array,
    signature: string,
    secret: string,
    options: WebhookVerificationOptions = {},
): true {
    if (typeof signature !== "string" || !signature) {
        throw new WebhookSignatureVerificationError("Missing Prontuno-Signature header");
    }
    if (typeof secret !== "string" || !secret) {
        throw new WebhookSignatureVerificationError("A webhook signing secret is required");
    }

    const parsed = parseSignature(signature);
    const body = typeof rawBody === "string" ? Buffer.from(rawBody) : Buffer.from(rawBody);
    const expected = createHmac("sha256", secret)
        .update(`${parsed.timestamp}.`)
        .update(body)
        .digest();

    const matches = parsed.signatures.some((candidate) => {
        if (!/^[a-f0-9]{64}$/i.test(candidate)) {
            return false;
        }
        const candidateBuffer = Buffer.from(candidate, "hex");
        return (
            candidateBuffer.length === expected.length && timingSafeEqual(candidateBuffer, expected)
        );
    });

    if (!matches) {
        throw new WebhookSignatureVerificationError("Webhook signature does not match the payload");
    }

    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
    if (!Number.isFinite(tolerance) || tolerance < 0) {
        throw new WebhookSignatureVerificationError(
            "Webhook tolerance must be a non-negative number",
        );
    }
    const now =
        options.now instanceof Date
            ? options.now.getTime() / 1_000
            : (options.now ?? Date.now() / 1_000);
    if (!Number.isFinite(now)) {
        throw new WebhookSignatureVerificationError("Webhook verification time must be finite");
    }
    if (tolerance > 0 && Math.abs(now - parsed.timestamp) > tolerance) {
        throw new WebhookSignatureVerificationError(
            "Webhook signature timestamp is outside the tolerance window",
        );
    }

    return true;
}

/**
 * Verifies the signature, then parses the event. Event types added to Prontuno after this
 * SDK version are returned as they are, so handle unrecognised `type` values with a default
 * branch instead of failing the delivery.
 */
export function constructWebhookEvent(
    rawBody: string | Uint8Array,
    signature: string,
    secret: string,
    options: WebhookVerificationOptions = {},
): WebhookEvent {
    verifyWebhookSignature(rawBody, signature, secret, options);

    let payload: unknown;
    try {
        payload = JSON.parse(
            typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
        );
    } catch (error) {
        throw new WebhookPayloadError("Webhook payload is not valid JSON", { cause: error });
    }

    if (!isWebhookEvent(payload)) {
        throw new WebhookPayloadError("Webhook payload does not match the Prontuno event schema");
    }
    return payload;
}

function parseSignature(value: string): { timestamp: number; signatures: string[] } {
    const parts = value.split(",").map((part) => part.trim().split("=", 2));
    const timestampValue = parts.find(([key]) => key === "t")?.[1];
    const timestamp = Number(timestampValue);
    const signatures = parts
        .filter(([key]) => key === "v1")
        .map(([, signature]) => signature ?? "");

    if (!Number.isInteger(timestamp) || timestamp <= 0 || signatures.length === 0) {
        throw new WebhookSignatureVerificationError(
            "Prontuno-Signature header has an invalid format",
        );
    }

    return { timestamp, signatures };
}

function isWebhookEvent(value: unknown): value is WebhookEvent {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const event = value as Record<string, unknown>;
    return (
        typeof event.event_id === "string" &&
        typeof event.webhook_id === "string" &&
        typeof event.type === "string" &&
        event.type !== "" &&
        typeof event.created_at === "string" &&
        Boolean(event.data) &&
        typeof event.data === "object" &&
        !Array.isArray(event.data)
    );
}
