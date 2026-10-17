import { ProntunoConfigError, ProntunoConnectionError } from "./errors.js";
import type { CursorPagination } from "./types.js";

const DEFAULT_MAX_PAGES = 1_000;

export class PaginationGuard {
    private readonly maxPages: number;
    private readonly seenCursors = new Set<string>();
    private pages = 0;

    constructor(maxPages: number | undefined, initialCursor: string | undefined) {
        const resolvedMaxPages = maxPages ?? DEFAULT_MAX_PAGES;
        if (!Number.isSafeInteger(resolvedMaxPages) || resolvedMaxPages <= 0) {
            throw new ProntunoConfigError("maxPages must be a positive safe integer");
        }

        this.maxPages = resolvedMaxPages;
        if (initialCursor) {
            this.seenCursors.add(initialCursor);
        }
    }

    next(pagination: CursorPagination): string | undefined {
        this.pages += 1;
        if (!pagination.has_more) {
            return undefined;
        }
        if (this.pages >= this.maxPages) {
            throw new ProntunoConnectionError(
                `Prontuno API pagination exceeded the maximum of ${this.maxPages} pages`,
            );
        }

        const cursor = pagination.next_cursor;
        if (!cursor) {
            throw new ProntunoConnectionError(
                "Prontuno API pagination indicated more results without a next cursor",
            );
        }
        if (this.seenCursors.has(cursor)) {
            throw new ProntunoConnectionError("Prontuno API returned a repeated pagination cursor");
        }

        this.seenCursors.add(cursor);
        return cursor;
    }
}
