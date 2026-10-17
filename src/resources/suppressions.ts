import type { HttpClient } from "../http.js";
import { pathId } from "../paths.js";
import { PaginationGuard } from "../pagination.js";
import type {
    CreateSuppressionInput,
    ListResponse,
    RequestOptions,
    Suppression,
    SuppressionListOptions,
} from "../types.js";

export class Suppressions {
    constructor(private readonly client: HttpClient) {}

    create(input: CreateSuppressionInput, options: RequestOptions = {}): Promise<Suppression> {
        return this.client.request<Suppression>("suppressions", {
            ...options,
            method: "POST",
            body: input,
        });
    }

    async retrieve(idOrEmail: string, options: RequestOptions = {}): Promise<Suppression> {
        return this.client.request<Suppression>(
            `suppressions/${pathId("suppression", idOrEmail)}`,
            options,
        );
    }

    async delete(idOrEmail: string, options: RequestOptions = {}): Promise<void> {
        return this.client.request<void>(`suppressions/${pathId("suppression", idOrEmail)}`, {
            ...options,
            method: "DELETE",
        });
    }

    list(options: SuppressionListOptions = {}): Promise<ListResponse<Suppression>> {
        const { limit, cursor, email, maxPages: _maxPages, ...requestOptions } = options;
        return this.client.request<ListResponse<Suppression>>("suppressions", {
            ...requestOptions,
            query: { limit, cursor, email },
        });
    }

    async *listAll(
        options: SuppressionListOptions = {},
    ): AsyncGenerator<Suppression, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list({ ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }
}
