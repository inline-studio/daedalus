import type { ChannelsConfig } from "../config/schema.js";
import type { SessionStore } from "../sessions/store.js";
import type { Channel } from "./base.js";
import { CliChannel } from "./cli.js";
import { WebChannel } from "./web.js";
import { TelegramChannel } from "./telegram.js";
import { WhatsappChannel } from "./whatsapp.js";

// `sessions` is threaded in so the web channel can serve session history (GET /history).
export function buildChannels(config: ChannelsConfig, sessions?: SessionStore): Channel[] {
  const out: Channel[] = [];
  if (config.cli?.enabled) {
    out.push(new CliChannel({ defaultAgent: config.cli.defaultAgent }));
  }
  if (config.web?.enabled) {
    out.push(
      new WebChannel({
        defaultAgent: config.web.defaultAgent,
        ...(config.web.port !== undefined ? { port: config.web.port } : {}),
        ...(config.web.token ? { token: config.web.token } : {}),
        ...(sessions ? { sessions } : {}),
      }),
    );
  }
  if (config.telegram?.enabled) {
    out.push(
      new TelegramChannel({
        defaultAgent: config.telegram.defaultAgent,
        token: config.telegram.token,
      }),
    );
  }
  if (config.whatsapp?.enabled) {
    out.push(
      new WhatsappChannel({
        defaultAgent: config.whatsapp.defaultAgent,
        accessToken: config.whatsapp.accessToken,
        phoneNumberId: config.whatsapp.phoneNumberId,
      }),
    );
  }
  return out;
}
