import type { HttpClient } from "../http.js";
import { pathId } from "../paths.js";
import { PaginationGuard } from "../pagination.js";
import type {
    ApiKey,
    ApiKeyListOptions,
    ApiKeyWithSecret,
    CreateApiKeyInput,
    ListResponse,
    RequestOptions,
} from "../types.js";

export class ApiKeys {
    constructor(private readonly client: HttpClient) {}

    /** The plaintext `key` is returned only once, so store it securely. */
    create(input: CreateApiKeyInput, options: RequestOptions = {}): Promise<ApiKeyWithSecret> {
        return this.client.request<ApiKeyWithSecret>("api-keys", {
            ...options,
            method: "POST",
            body: input,
        });
    }

    async retrieve(apiKeyId: string, options: RequestOptions = {}): Promise<ApiKey> {
        return this.client.request<ApiKey>(`api-keys/${pathId("API key", apiKeyId)}`, options);
    }

    /** Permanently revokes the key. Requests using it fail immediately. */
    async revoke(apiKeyId: string, options: RequestOptions = {}): Promise<void> {
        return this.client.request<void>(`api-keys/${pathId("API key", apiKeyId)}`, {
            ...options,
            method: "DELETE",
        });
    }

    list(options: ApiKeyListOptions = {}): Promise<ListResponse<ApiKey>> {
        const { limit, cursor, status, type, maxPages: _maxPages, ...requestOptions } = options;
        return this.client.request<ListResponse<ApiKey>>("api-keys", {
            ...requestOptions,
            query: { limit, cursor, status, type },
        });
    }

    async *listAll(options: ApiKeyListOptions = {}): AsyncGenerator<ApiKey, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list({ ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }
}
