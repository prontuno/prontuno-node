import type { HttpClient } from "../http.js";
import { pathId } from "../paths.js";
import { PaginationGuard } from "../pagination.js";
import type {
    CreateSmtpCredentialInput,
    ListResponse,
    RequestOptions,
    SmtpCredential,
    SmtpCredentialListOptions,
    SmtpCredentialWithPassword,
} from "../types.js";

export class SmtpCredentials {
    constructor(private readonly client: HttpClient) {}

    /** The `password` is returned only once, so store it securely. */
    create(
        input: CreateSmtpCredentialInput,
        options: RequestOptions = {},
    ): Promise<SmtpCredentialWithPassword> {
        return this.client.request<SmtpCredentialWithPassword>("smtp-credentials", {
            ...options,
            method: "POST",
            body: input,
        });
    }

    async retrieve(
        smtpCredentialId: string,
        options: RequestOptions = {},
    ): Promise<SmtpCredential> {
        return this.client.request<SmtpCredential>(
            `smtp-credentials/${pathId("SMTP credential", smtpCredentialId)}`,
            options,
        );
    }

    /** Permanently revokes the credential. SMTP logins using it fail immediately. */
    async revoke(smtpCredentialId: string, options: RequestOptions = {}): Promise<void> {
        return this.client.request<void>(
            `smtp-credentials/${pathId("SMTP credential", smtpCredentialId)}`,
            { ...options, method: "DELETE" },
        );
    }

    /** Replaces the password. The old password stops working immediately. */
    async resetPassword(
        smtpCredentialId: string,
        options: RequestOptions = {},
    ): Promise<SmtpCredentialWithPassword> {
        return this.client.request<SmtpCredentialWithPassword>(
            `smtp-credentials/${pathId("SMTP credential", smtpCredentialId)}/reset-password`,
            { ...options, method: "POST" },
        );
    }

    list(options: SmtpCredentialListOptions = {}): Promise<ListResponse<SmtpCredential>> {
        const { limit, cursor, status, maxPages: _maxPages, ...requestOptions } = options;
        return this.client.request<ListResponse<SmtpCredential>>("smtp-credentials", {
            ...requestOptions,
            query: { limit, cursor, status },
        });
    }

    async *listAll(
        options: SmtpCredentialListOptions = {},
    ): AsyncGenerator<SmtpCredential, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list({ ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }
}
