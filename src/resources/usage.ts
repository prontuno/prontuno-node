import type { HttpClient } from "../http.js";
import type { RequestOptions, Usage as UsageResponse } from "../types.js";

export class Usage {
    constructor(private readonly client: HttpClient) {}

    retrieve(options: RequestOptions = {}): Promise<UsageResponse> {
        return this.client.request<UsageResponse>("usage", options);
    }
}
