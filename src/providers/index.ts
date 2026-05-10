import type { ArtemisConfig } from "../config/schema.js";
import type { AgentManifest } from "../config/schema.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai.js";
import type { LLMProvider } from "./base.js";

export { AnthropicProvider, OpenAICompatibleProvider };
export type { LLMProvider };

export function buildProvider(agent: AgentManifest, config: ArtemisConfig): LLMProvider {
  switch (agent.provider) {
    case "anthropic": {
      const cfg = config.providers.anthropic ?? {};
      return new AnthropicProvider({
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      });
    }
    case "openai": {
      const cfg = config.providers.openai ?? {};
      return new OpenAICompatibleProvider({
        flavor: "openai",
        ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      });
    }
    case "ollama": {
      const ollama = config.providers.ollama ?? { baseUrl: "http://localhost:11434" };
      // Ollama exposes an OpenAI-compatible endpoint at /v1
      return new OpenAICompatibleProvider({
        flavor: "ollama",
        baseUrl: `${ollama.baseUrl.replace(/\/$/, "")}/v1`,
        apiKey: "ollama",
      });
    }
  }
}
