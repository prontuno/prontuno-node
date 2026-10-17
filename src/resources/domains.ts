import type { HttpClient } from "../http.js";
import { pathId } from "../paths.js";
import { PaginationGuard } from "../pagination.js";
import type {
    CreateDomainInput,
    Domain,
    DomainDetails,
    ListOptions,
    ListResponse,
    RequestOptions,
} from "../types.js";

export class Domains {
    constructor(private readonly client: HttpClient) {}

    create(input: CreateDomainInput, options: RequestOptions = {}): Promise<DomainDetails> {
        return this.client.request<DomainDetails>("domains", {
            ...options,
            method: "POST",
            body: input,
        });
    }

    async retrieve(domainId: string, options: RequestOptions = {}): Promise<DomainDetails> {
        return this.client.request<DomainDetails>(`domains/${pathId("domain", domainId)}`, options);
    }

    list(options: ListOptions = {}): Promise<ListResponse<Domain>> {
        const { limit, cursor, maxPages: _maxPages, ...requestOptions } = options;
        return this.client.request<ListResponse<Domain>>("domains", {
            ...requestOptions,
            query: { limit, cursor },
        });
    }

    async *listAll(options: ListOptions = {}): AsyncGenerator<Domain, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list({ ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }
}
