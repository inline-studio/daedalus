import type { ChannelsConfig } from "../config/schema.js";
import type { SessionStore } from "../sessions/store.js";
import { loadAgent } from "../brain/agents.js";
import { loadAgentCommands } from "../brain/commands.js";
import type { Channel } from "./base.js";
import { CliChannel } from "./cli.js";
import { WebChannel, type WebCommandInfo } from "./web.js";
import { TelegramChannel } from "./telegram.js";
import { WhatsappChannel } from "./whatsapp.js";

// `sessions` is threaded in so the web channel can serve session history (GET /history).
// `identityName` is the orchestrator's user-facing name (config.identity.name) — the web
// channel uses it to label the assistant in the "copy conversation" transcript.
// `brainPath` lets the web channel serve the default agent's slash-commands (GET /commands,
// powering the UI's autocomplete); without it the endpoint reports none.
export function buildChannels(
  config: ChannelsConfig,
  sessions?: SessionStore,
  identityName?: string,
  brainPath?: string,
  // Extra web-channel wiring the supervisor owns: the GET /status snapshot provider and
  // the POST /abort in-flight-turn canceller.
  extras?: {
    status?: () => Promise<Record<string, unknown>>;
    abort?: (conversationId: string) => Promise<boolean>;
  },
): Channel[] {
  const out: Channel[] = [];
  if (config.cli?.enabled) {
    out.push(
      new CliChannel({
        defaultAgent: config.cli.defaultAgent,
        subagentEvents: config.cli.subagentEvents,
      }),
    );
  }
  if (config.web?.enabled) {
    // Built-in login is active only when all three pieces are present (username + password
    // hash + a session-signing secret). When it is, the bearer token is ignored.
    const w = config.web;
    const auth =
      w.username && w.passwordHash && w.sessionSecret
        ? { username: w.username, passwordHash: w.passwordHash, sessionSecret: w.sessionSecret }
        : undefined;
    // Resolve the default agent's slash-commands on demand (per request, so brain edits
    // show up live). Any load failure degrades to "no commands" rather than failing the UI.
    const listCommands = brainPath
      ? async (): Promise<WebCommandInfo[]> => {
          try {
            const agent = await loadAgent(brainPath, w.defaultAgent);
            const commands = await loadAgentCommands(brainPath, agent.manifest.commands);
            return commands.map((c) => ({
              name: c.manifest.name,
              description: c.manifest.description,
              aliases: c.manifest.aliases,
            }));
          } catch {
            return [];
          }
        }
      : undefined;
    out.push(
      new WebChannel({
        defaultAgent: w.defaultAgent,
        ...(w.port !== undefined ? { port: w.port } : {}),
        ...(w.token ? { token: w.token } : {}),
        ...(auth ? { auth } : {}),
        ...(sessions ? { sessions } : {}),
        ...(identityName ? { assistantName: identityName } : {}),
        ...(w.userName ? { userName: w.userName } : {}),
        ...(listCommands ? { listCommands } : {}),
        ...(extras?.status ? { status: extras.status } : {}),
        ...(extras?.abort ? { abortTurn: extras.abort } : {}),
        ...(w.remoteExec?.enabled
          ? { remoteExec: { enabled: true, timeoutMs: w.remoteExec.timeoutMs } }
          : {}),
      }),
    );
  }
  if (config.telegram?.enabled) {
    out.push(
      new TelegramChannel({
        defaultAgent: config.telegram.defaultAgent,
        token: config.telegram.token,
        ...(config.telegram.allowedChatIds ? { allowedChatIds: config.telegram.allowedChatIds } : {}),
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
