import type { HttpClient } from "../http.js";
import { pathId } from "../paths.js";
import { PaginationGuard } from "../pagination.js";
import type { ListOptions, ListResponse, RequestOptions, SentEmailAttachment } from "../types.js";

export class SentEmailAttachments {
    constructor(private readonly client: HttpClient) {}

    /**
     * One page of a sent email's attachments, each with a fresh one-hour `download_url`
     * (null while the file hasn't finished uploading).
     */
    async list(
        emailId: string,
        options: ListOptions = {},
    ): Promise<ListResponse<SentEmailAttachment>> {
        const { limit, cursor, maxPages: _maxPages, ...requestOptions } = options;
        return this.client.request<ListResponse<SentEmailAttachment>>(
            `emails/${pathId("email", emailId)}/attachments`,
            { ...requestOptions, query: { limit, cursor } },
        );
    }

    async *listAll(
        emailId: string,
        options: ListOptions = {},
    ): AsyncGenerator<SentEmailAttachment, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list(emailId, { ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }

    /**
     * Attachment metadata with a fresh signed `download_url` that expires after one hour.
     * Rejects with a 403 `attachment_unavailable` while the file hasn't finished uploading.
     */
    async retrieve(
        emailId: string,
        attachmentId: string,
        options: RequestOptions = {},
    ): Promise<SentEmailAttachment> {
        return this.client.request<SentEmailAttachment>(
            `emails/${pathId("email", emailId)}/attachments/${pathId("attachment", attachmentId)}`,
            options,
        );
    }
}
