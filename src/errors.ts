import type { ApiErrorBody, ApiErrorDetail, RateLimit, SuggestedAction } from "./types.js";

export class ProntunoError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "ProntunoError";
    }
}

export class ProntunoConfigError extends ProntunoError {
    constructor(message: string) {
        super(message);
        this.name = "ProntunoConfigError";
    }
}

export interface ApiErrorOptions {
    status: number;
    body: ApiErrorBody;
    headers: Headers;
}

export class ProntunoApiError extends ProntunoError {
    readonly status: number;
    readonly code: string;
    readonly requestId: string | null;
    readonly retryable: boolean;
    readonly suggestedAction: SuggestedAction | null;
    readonly details: ApiErrorBody["errors"];
    readonly body: ApiErrorBody;
    readonly headers: Headers;
    readonly retryAfter: number | null;
    readonly rateLimit: RateLimit;

    constructor({ status, body, headers }: ApiErrorOptions) {
        const primary = normalizePrimaryError(status, body);
        super(primary.message);
        this.name = "ProntunoApiError";
        this.status = status;
        this.code = primary.code;
        this.requestId = headers.get("x-request-id");
        this.retryable = primary.retryable ?? status >= 500;
        this.suggestedAction = primary.suggested_action ?? null;
        this.details = body.errors;
        this.body = body;
        this.headers = headers;
        this.retryAfter = parseIntegerHeader(headers, "retry-after");
        this.rateLimit = {
            limit: parseIntegerHeader(headers, "ratelimit-limit"),
            remaining: parseIntegerHeader(headers, "ratelimit-remaining"),
            reset: parseIntegerHeader(headers, "ratelimit-reset"),
        };
    }
}

export class ProntunoConnectionError extends ProntunoError {
    constructor(message = "Could not connect to the Prontuno API", options?: ErrorOptions) {
        super(message, options);
        this.name = "ProntunoConnectionError";
    }
}

export class ProntunoTimeoutError extends ProntunoConnectionError {
    readonly timeout: number;

    constructor(timeout: number, options?: ErrorOptions) {
        super(`Prontuno API request timed out after ${timeout}ms`, options);
        this.name = "ProntunoTimeoutError";
        this.timeout = timeout;
    }
}

export class WebhookSignatureVerificationError extends ProntunoError {
    constructor(message: string) {
        super(message);
        this.name = "WebhookSignatureVerificationError";
    }
}

export class WebhookPayloadError extends ProntunoError {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "WebhookPayloadError";
    }
}

function normalizePrimaryError(status: number, body: ApiErrorBody): ApiErrorDetail {
    if (body.error && typeof body.error === "object") {
        return body.error;
    }

    return {
        code: "api_error",
        message: `Prontuno API request failed with status ${status}`,
        retryable: status >= 500,
    };
}

function parseIntegerHeader(headers: Headers, name: string): number | null {
    const value = headers.get(name);
    if (value === null) {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}
