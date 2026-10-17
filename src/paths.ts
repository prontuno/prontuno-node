import { ProntunoConfigError } from "./errors.js";

/** Encodes one identifier as a path segment, rejecting values that would change the path. */
export function pathId(label: string, id: string): string {
    if (typeof id !== "string" || id.trim() === "" || id === "." || id === "..") {
        throw new ProntunoConfigError(`A ${label} identifier is required`);
    }
    return encodeURIComponent(id);
}
