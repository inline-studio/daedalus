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
    // Built-in login is active only when all three pieces are present (username + password
    // hash + a session-signing secret). When it is, the bearer token is ignored.
    const w = config.web;
    const auth =
      w.username && w.passwordHash && w.sessionSecret
        ? { username: w.username, passwordHash: w.passwordHash, sessionSecret: w.sessionSecret }
        : undefined;
    out.push(
      new WebChannel({
        defaultAgent: w.defaultAgent,
        ...(w.port !== undefined ? { port: w.port } : {}),
        ...(w.token ? { token: w.token } : {}),
        ...(auth ? { auth } : {}),
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
