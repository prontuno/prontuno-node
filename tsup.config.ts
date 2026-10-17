import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    // Keep "node:crypto" as written. Deno only resolves built-ins with the node: prefix.
    removeNodeProtocol: false,
});
