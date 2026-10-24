import { ApiKeys } from "./resources/api-keys.js";
import { Domains } from "./resources/domains.js";
import { Emails } from "./resources/emails.js";
import { SmtpCredentials } from "./resources/smtp-credentials.js";
import { Suppressions } from "./resources/suppressions.js";
import { Usage } from "./resources/usage.js";
import { HttpClient, type ResponseMetadata } from "./http.js";
import { ProntunoConfigError } from "./errors.js";
import type { ClientOptions } from "./types.js";
import { Webhooks } from "./webhooks.js";

export class Prontuno {
    readonly emails: Emails;
    readonly domains: Domains;
    readonly suppressions: Suppressions;
    readonly webhooks: Webhooks;
    readonly apiKeys: ApiKeys;
    readonly smtpCredentials: SmtpCredentials;
    readonly usage: Usage;
    private readonly http: HttpClient;
    private readonly options: ClientOptions;

    /**
     * Pass one API key for every request, or separate keys:
     * `new Prontuno({ sendingKey, managementKey })`. Sends use the sending key and
     * every other request uses the management key.
     */
    constructor(apiKeyOrOptions: string | ClientOptions) {
        const options =
            typeof apiKeyOrOptions === "string" ? { apiKey: apiKeyOrOptions } : apiKeyOrOptions;
        this.http = new HttpClient(options);
        this.options = options;
        this.emails = new Emails(this.http);
        this.domains = new Domains(this.http);
        this.suppressions = new Suppressions(this.http);
        this.webhooks = new Webhooks(this.http);
        this.apiKeys = new ApiKeys(this.http);
        this.smtpCredentials = new SmtpCredentials(this.http);
        this.usage = new Usage(this.http);
    }

    /**
     * Returns a client that sends with a different domain's sending key, keeping
     * every other setting, including the management key.
     */
    withSendingKey(sendingKey: string): Prontuno {
        if (typeof sendingKey !== "string" || sendingKey.trim() === "") {
            throw new ProntunoConfigError("withSendingKey() requires a non-empty sending key");
        }
        return new Prontuno({ ...this.options, sendingKey });
    }

    get lastResponse(): ResponseMetadata | null {
        return this.http.lastResponse;
    }
}
