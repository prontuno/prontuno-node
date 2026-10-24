import { Buffer } from "node:buffer";
import {
    ProntunoApiError,
    ProntunoConfigError,
    ProntunoConnectionError,
    ProntunoTimeoutError,
} from "./errors.js";
import type { ApiErrorBody, ClientOptions, Fetch, RateLimit, RequestOptions } from "./types.js";

const DEFAULT_BASE_URL = "https://api.prontuno.net/v1";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const MAX_RETRY_DELAY = 60_000;
const DEFAULT_USER_AGENT = "prontuno-node/0.2.0";

export interface HttpRequestOptions extends RequestOptions {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    idempotencyKey?: string;
    /** Authenticate with the sending key instead of the management key. */
    sending?: boolean;
}

export interface ResponseMetadata {
    requestId: string | null;
    rateLimit: RateLimit;
}

export class HttpClient {
    readonly baseUrl: string;
    private readonly sendingKey: string | undefined;
    private readonly managementKey: string | undefined;
    readonly timeout: number;
    readonly maxRetries: number;
    readonly maxResponseSize: number;
    readonly fetch: Fetch;
    readonly userAgent: string;
    lastResponse: ResponseMetadata | null = null;

    constructor(options: ClientOptions | null | undefined) {
        if (!options) {
            throw new ProntunoConfigError("A non-empty Prontuno API key is required");
        }
        const apiKey = normalizeKey(options.apiKey);
        this.sendingKey = normalizeKey(options.sendingKey) ?? apiKey;
        this.managementKey = normalizeKey(options.managementKey) ?? apiKey;
        if (!this.sendingKey && !this.managementKey) {
            throw new ProntunoConfigError(
                "A non-empty Prontuno API key is required (apiKey, sendingKey, or managementKey)",
            );
        }
        if (
            options.timeout !== undefined &&
            (!Number.isFinite(options.timeout) || options.timeout <= 0)
        ) {
            throw new ProntunoConfigError("timeout must be a positive number");
        }
        if (
            options.maxRetries !== undefined &&
            (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)
        ) {
            throw new ProntunoConfigError("maxRetries must be a non-negative integer");
        }
        if (
            options.maxResponseSize !== undefined &&
            (!Number.isSafeInteger(options.maxResponseSize) || options.maxResponseSize <= 0)
        ) {
            throw new ProntunoConfigError("maxResponseSize must be a positive safe integer");
        }

        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? baseUrlFromEnv() ?? DEFAULT_BASE_URL);
        this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
        this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.maxResponseSize = options.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
        this.fetch = options.fetch ?? globalThis.fetch;
        this.userAgent = userAgent(options.appInfo);

        if (typeof this.fetch !== "function") {
            throw new ProntunoConfigError("No fetch implementation is available");
        }
    }

    async request<T>(path: string, options: HttpRequestOptions = {}): Promise<T> {
        const method = options.method ?? "GET";
        const timeout = options.timeout ?? this.timeout;
        const maxRetries = options.maxRetries ?? this.maxRetries;
        const maxResponseSize = options.maxResponseSize ?? this.maxResponseSize;
        if (!Number.isFinite(timeout) || timeout <= 0) {
            throw new ProntunoConfigError("timeout must be a positive number");
        }
        if (!Number.isInteger(maxRetries) || maxRetries < 0) {
            throw new ProntunoConfigError("maxRetries must be a non-negative integer");
        }
        if (!Number.isSafeInteger(maxResponseSize) || maxResponseSize <= 0) {
            throw new ProntunoConfigError("maxResponseSize must be a positive safe integer");
        }
        const apiKey = options.sending ? this.sendingKey : this.managementKey;
        if (!apiKey) {
            const [role, option] = options.sending
                ? ["sending", "sendingKey"]
                : ["management", "managementKey"];
            throw new ProntunoConfigError(
                `${method} /${path} requires a ${role} API key; pass ${option} (or apiKey) when creating the client`,
            );
        }
        const url = buildUrl(this.baseUrl, path, options.query);
        const headers = new Headers(options.headers);
        headers.set("Accept", "application/json");
        headers.set("Authorization", `Bearer ${apiKey}`);
        headers.set("User-Agent", this.userAgent);

        let serializedBody: string | undefined;
        if (options.body !== undefined) {
            headers.set("Content-Type", "application/json");
            serializedBody = JSON.stringify(options.body);
        }
        if (options.idempotencyKey) {
            headers.set("Idempotency-Key", options.idempotencyKey);
        }

        const init: RequestInit = {
            method,
            headers,
            ...(serializedBody === undefined ? {} : { body: serializedBody }),
        };
        // Set once an attempt may have reached the API without a usable response, so a
        // retried DELETE that finds the resource already gone counts as success.
        let mayHaveApplied = false;

        for (let attempt = 0; ; attempt += 1) {
            let response: Response;
            let parsedBody: unknown;
            try {
                ({ response, parsedBody } = await this.attempt(
                    url,
                    init,
                    options.signal,
                    timeout,
                    maxResponseSize,
                ));
            } catch (error) {
                if (error instanceof ResponseSizeError || options.signal?.aborted) {
                    throw error;
                }
                const failure =
                    error instanceof ProntunoConnectionError
                        ? error
                        : new ProntunoConnectionError(undefined, { cause: error });
                if (attempt >= maxRetries || !isSafeToRetry(method, options.idempotencyKey)) {
                    throw failure;
                }

                mayHaveApplied = true;
                await delay(retryDelay(attempt), options.signal);
                continue;
            }

            this.lastResponse = responseMetadata(response.headers);

            if (response.ok) {
                return parsedBody as T;
            }

            const error = new ProntunoApiError({
                status: response.status,
                body: normalizeErrorBody(parsedBody),
                headers: response.headers,
            });
            if (mayHaveApplied && method === "DELETE" && isAlreadyDeleted(error)) {
                return undefined as T;
            }
            if (
                attempt >= maxRetries ||
                !shouldRetryResponse(error, method, options.idempotencyKey)
            ) {
                throw error;
            }

            mayHaveApplied ||= error.status === 408 || error.status >= 500;
            await delay(retryDelay(attempt, response.headers), options.signal);
        }
    }

    /** One HTTP attempt; `timeout` covers the request and reading the response body. */
    private async attempt(
        url: string,
        init: RequestInit,
        signal: AbortSignal | undefined,
        timeout: number,
        maxResponseSize: number,
    ): Promise<{ response: Response; parsedBody: unknown }> {
        const controller = new AbortController();
        const detachSignal = forwardAbort(signal, controller);
        const timer = setTimeout(() => controller.abort("timeout"), timeout);

        let result: { response: Response; parsedBody: unknown };
        try {
            const response = await this.fetch(url, { ...init, signal: controller.signal });
            result = { response, parsedBody: await parseResponseBody(response, maxResponseSize) };
        } catch (error) {
            if (!signal?.aborted && controller.signal.aborted) {
                throw new ProntunoTimeoutError(timeout, { cause: error });
            }
            throw error;
        } finally {
            clearTimeout(timer);
            detachSignal();
        }
        return result;
    }
}

class ResponseSizeError extends ProntunoConnectionError {}

// The SDK's own identifier always comes first, so requests can be traced to an SDK version.
function userAgent(appInfo: unknown): string {
    if (appInfo === undefined || appInfo === null) {
        return DEFAULT_USER_AGENT;
    }
    // oxlint-disable-next-line no-control-regex
    if (typeof appInfo !== "string" || /[\u0000-\u001f\u007f]/.test(appInfo)) {
        throw new ProntunoConfigError("appInfo must be a single-line string");
    }

    const trimmed = appInfo.trim();
    return trimmed === "" ? DEFAULT_USER_AGENT : `${DEFAULT_USER_AGENT} ${trimmed}`;
}

function normalizeKey(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function baseUrlFromEnv(): string | undefined {
    const value = typeof process === "undefined" ? undefined : process.env.PRONTUNO_BASE_URL;
    return value?.trim() || undefined;
}

// Require HTTPS so the API key is never sent in plain text. Plain HTTP is only
// accepted for loopback hosts, whose traffic never leaves the machine.
function normalizeBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new ProntunoConfigError("baseUrl must be a valid absolute URL");
    }

    if (url.protocol === "http:") {
        if (!isLoopbackHostname(url.hostname)) {
            throw new ProntunoConfigError(
                "baseUrl must use https (plain http is only allowed for loopback hosts)",
            );
        }
    } else if (url.protocol !== "https:") {
        throw new ProntunoConfigError("baseUrl must use https");
    }

    return url.toString().replace(/\/$/, "");
}

function isLoopbackHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

function buildUrl(baseUrl: string, path: string, query: HttpRequestOptions["query"]): string {
    const url = new URL(`${baseUrl}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) {
            url.searchParams.set(key, String(value));
        }
    }
    return url.toString();
}

async function parseResponseBody(response: Response, maxResponseSize: number): Promise<unknown> {
    if (response.status === 204) {
        return undefined;
    }

    const text = await readResponseText(response, maxResponseSize);
    if (!text) {
        if (response.ok) {
            throw new ProntunoConnectionError("Prontuno API returned an empty response");
        }
        return undefined;
    }

    try {
        return JSON.parse(text) as unknown;
    } catch (error) {
        if (response.ok) {
            throw new ProntunoConnectionError("Prontuno API returned invalid JSON", {
                cause: error,
            });
        }
        return { error: { code: "invalid_response", message: text, retryable: false } };
    }
}

async function readResponseText(response: Response, maxResponseSize: number): Promise<string> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxResponseSize) {
        await cancelResponseBody(response);
        throw responseSizeError(maxResponseSize);
    }

    if (!response.body) {
        return "";
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (!value) {
            continue;
        }

        totalBytes += value.byteLength;
        if (totalBytes > maxResponseSize) {
            try {
                await reader.cancel();
            } catch {
                // Preserve the response-size failure if cancellation also fails.
            }
            throw responseSizeError(maxResponseSize);
        }
        chunks.push(value);
    }

    return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function cancelResponseBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // Preserve the response-size failure if cancellation also fails.
    }
}

function responseSizeError(maxResponseSize: number): ResponseSizeError {
    return new ResponseSizeError(
        `Prontuno API response exceeded the maximum size of ${maxResponseSize} bytes`,
    );
}

function normalizeErrorBody(value: unknown): ApiErrorBody {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as ApiErrorBody;
    }
    return {};
}

function responseMetadata(headers: Headers): ResponseMetadata {
    return {
        requestId: headers.get("x-request-id"),
        rateLimit: {
            limit: parseNumber(headers.get("ratelimit-limit")),
            remaining: parseNumber(headers.get("ratelimit-remaining")),
            reset: parseNumber(headers.get("ratelimit-reset")),
        },
    };
}

function parseNumber(value: string | null): number | null {
    if (value === null) {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function isSafeToRetry(method: string, idempotencyKey?: string): boolean {
    return method === "GET" || method === "DELETE" || Boolean(idempotencyKey);
}

// A DELETE retried after an attempt that may have succeeded finds the resource gone.
function isAlreadyDeleted(error: ProntunoApiError): boolean {
    return error.status === 404 || (error.status === 409 && error.code === "already_revoked");
}

function shouldRetryResponse(
    error: ProntunoApiError,
    method: string,
    idempotencyKey?: string,
): boolean {
    if (!isSafeToRetry(method, idempotencyKey)) {
        return false;
    }
    return (
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500 ||
        (error.status === 409 && error.code === "idempotency_request_in_progress")
    );
}

function retryDelay(attempt: number, headers?: Headers): number {
    const retryAfter = headers?.get("retry-after");
    if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1_000, MAX_RETRY_DELAY);
        }
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) {
            return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_DELAY);
        }
    }

    return Math.min(500 * 2 ** attempt, 5_000) * (0.75 + Math.random() * 0.5);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, milliseconds);
        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
    if (!signal) {
        return () => undefined;
    }
    if (signal.aborted) {
        controller.abort(signal.reason);
        return () => undefined;
    }

    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
}
