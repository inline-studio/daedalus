import prompts from "prompts";
import {
  askDefaultAgent,
  backendForDisable,
  confirm,
  persistChannelConfig,
  persistChannelDisable,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
} from "./base.js";
import { secretPrompt } from "./secret-prompt.js";

const TOKEN_REGEX = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

interface TelegramBotInfo {
  id: number;
  username: string;
  first_name: string;
}

async function getMe(token: string): Promise<TelegramBotInfo> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const json = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    description?: string;
    result?: TelegramBotInfo;
  };
  if (!res.ok || !json.ok || !json.result) {
    throw new Error(json.description ?? `getMe returned HTTP ${res.status}`);
  }
  return json.result;
}

export const telegramSetup: ChannelSetup = {
  id: "telegram",
  title: "Telegram",
  summary: "Set up a Telegram bot. You'll need a bot token from @BotFather (https://t.me/BotFather).",

  async run(ctx: SetupContext): Promise<void> {
    console.log(`\n${this.title} setup — ${this.summary}\n`);
    console.log("If you don't have a bot yet:");
    console.log("  1. Open https://t.me/BotFather");
    console.log("  2. Send /newbot, follow prompts");
    console.log("  3. Copy the token shown\n");

    let bot: TelegramBotInfo | null = null;
    let token = "";
    while (!bot) {
      token =
        (await secretPrompt({
          message: "Bot token from @BotFather:",
          validate: (v: string) => TOKEN_REGEX.test(v) || "expected format <id>:<35+ char secret>",
        })) ?? "";
      if (!token) throw new Error("cancelled");
      try {
        process.stdout.write("validating with Telegram… ");
        bot = await getMe(token);
        process.stdout.write(`OK (@${bot.username}, id ${bot.id})\n`);
      } catch (err) {
        process.stdout.write("FAILED\n");
        console.error(`  ${(err as Error).message}`);
        const retry = await confirm("Try a different token?", true);
        if (!retry) throw new Error("cancelled");
      }
    }

    const proceed = await confirm(`Use bot @${bot.username}?`, true);
    if (!proceed) throw new Error("cancelled");

    const defaultAgent = await askDefaultAgent(ctx.brainPath);

    await persistChannelConfig({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      envUpdates: { TELEGRAM_BOT_TOKEN: token },
      yamlEdits: [
        { keyPath: ["channels", "telegram", "enabled"], value: true },
        { keyPath: ["channels", "telegram", "defaultAgent"], value: defaultAgent },
        { keyPath: ["channels", "telegram", "token"], value: "${TELEGRAM_BOT_TOKEN}" },
      ],
      channelId: "telegram",
    });
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will delete the saved Telegram bot token and remove all telegram config keys. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }
    await persistChannelDisable({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      channelId: "telegram",
      yamlSets: opts.purge ? [] : [{ keyPath: ["channels", "telegram", "enabled"], value: false }],
      yamlPurge: [["channels", "telegram"]],
      secretsToPurge: ["TELEGRAM_BOT_TOKEN"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });
  },
};
