import { ProxyAgent, setGlobalDispatcher } from "undici";
import type { OneCliConfig } from "../config/schema.js";
import { log } from "../log.js";

// OneCLI is an HTTP gateway (https://github.com/onecli/onecli). When enabled,
// we route Node fetch traffic through it. Provider SDKs (Anthropic, OpenAI) use
// undici under the hood, so setting the global dispatcher is sufficient.
//
// Agents send requests with placeholder API keys; OneCLI swaps in real ones at
// the proxy edge. The runner never touches real credentials.
export function applyOneCli(config: OneCliConfig): void {
  if (!config.enabled) return;

  const agent = new ProxyAgent({
    uri: config.proxy,
    ...(config.token
      ? {
          token: config.token.startsWith("Bearer ") ? config.token : `Bearer ${config.token}`,
        }
      : {}),
  });
  setGlobalDispatcher(agent);

  // Also export legacy env vars in case child processes / native libs honor them.
  process.env.HTTPS_PROXY = config.proxy;
  process.env.HTTP_PROXY = config.proxy;
  if (config.token) {
    process.env.PROXY_AUTHORIZATION = config.token.startsWith("Bearer ")
      ? config.token
      : `Bearer ${config.token}`;
  }

  log.info({ proxy: config.proxy }, "OneCLI proxy enabled");
}
