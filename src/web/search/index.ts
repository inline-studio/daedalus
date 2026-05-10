import type { WebConfig } from "../../config/schema.js";
import type { SearchProvider } from "./base.js";
import { DuckDuckGoProvider } from "./duckduckgo.js";
import { BraveProvider } from "./brave.js";

export type { SearchProvider, SearchResult } from "./base.js";
export { SearchError } from "./base.js";

export function buildSearchProvider(config: WebConfig): SearchProvider | null {
  const id = config.search?.provider;
  if (!id || id === "none") return null;
  switch (id) {
    case "duckduckgo":
      return new DuckDuckGoProvider();
    case "brave": {
      const key = config.search?.apiKey ?? "";
      if (!key) return null; // tool will report a clear error at call time
      return new BraveProvider(key);
    }
  }
}
