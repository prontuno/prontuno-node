import { Buffer } from "node:buffer";
import type { HttpClient } from "../http.js";
import { pathId } from "../paths.js";
import { PaginationGuard } from "../pagination.js";
import { SentEmailAttachments } from "./sent-email-attachments.js";
import type {
    Email,
    EmailDetails,
    EmailInput,
    EmailListOptions,
    IdempotentRequestOptions,
    ListResponse,
    RequestOptions,
    SendBatchResponse,
    SendEmailResponse,
} from "../types.js";

export class Emails {
    readonly attachments: SentEmailAttachments;

    constructor(private readonly client: HttpClient) {
        this.attachments = new SentEmailAttachments(client);
    }

    send(email: EmailInput, options: IdempotentRequestOptions = {}): Promise<SendEmailResponse> {
        return this.client.request<SendEmailResponse>("emails", {
            ...options,
            method: "POST",
            sending: true,
            body: normalizeEmailInput(email),
        });
    }

    /** Sends up to 1,000 separate emails in one request. If any item is invalid, nothing is sent. */
    sendBatch(
        emails: EmailInput[],
        options: IdempotentRequestOptions = {},
    ): Promise<SendBatchResponse> {
        return this.client.request<SendBatchResponse>("emails/batch", {
            ...options,
            method: "POST",
            sending: true,
            body: { emails: emails.map(normalizeEmailInput) },
        });
    }

    /** One email with its status, timestamps, stored text and HTML bodies, and attachments. */
    async retrieve(emailId: string, options: RequestOptions = {}): Promise<EmailDetails> {
        return this.client.request<EmailDetails>(`emails/${pathId("email", emailId)}`, options);
    }

    list(options: EmailListOptions = {}): Promise<ListResponse<Email>> {
        const {
            limit,
            cursor,
            domain_id,
            status,
            maxPages: _maxPages,
            ...requestOptions
        } = options;
        return this.client.request<ListResponse<Email>>("emails", {
            ...requestOptions,
            query: { limit, cursor, domain_id, status },
        });
    }

    async *listAll(options: EmailListOptions = {}): AsyncGenerator<Email, void, undefined> {
        let cursor = options.cursor;
        const guard = new PaginationGuard(options.maxPages, cursor);
        do {
            const page = await this.list({ ...options, ...(cursor ? { cursor } : {}) });
            yield* page.data;
            cursor = guard.next(page.pagination);
        } while (cursor);
    }
}

function normalizeEmailInput(email: EmailInput): Record<string, unknown> {
    if (!email.attachments) {
        return email as unknown as Record<string, unknown>;
    }

    return {
        ...email,
        attachments: email.attachments.map((attachment) => {
            if (typeof attachment.content === "string") {
                return attachment;
            }

            return {
                ...attachment,
                content: Buffer.from(attachment.content).toString("base64"),
                encoding: "base64",
            };
        }),
    };
}
