import prompts from "prompts";
import {
  backendForDisable,
  confirm,
  persistChannelConfig,
  persistChannelDisable,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
} from "./base.js";
import { secretPrompt } from "./secret-prompt.js";
import { DuckDuckGoProvider } from "../web/search/duckduckgo.js";
import { BraveProvider } from "../web/search/brave.js";

// Reusing the channel-setup interface for non-channel things isn't quite type-true, but the
// data flow is identical (prompt → validate → write env + yaml). The CLI dispatcher treats
// it the same way.
export const searchSetup: ChannelSetup = {
  id: "search",
  title: "Web search provider",
  summary:
    "Configure a backend for the web_search tool. DuckDuckGo works without a key (default); Brave Search needs an API key.",

  async run(ctx: SetupContext): Promise<void> {
    console.log(`\n${this.title} setup — ${this.summary}\n`);

    const choice = await prompts({
      type: "select",
      name: "provider",
      message: "Which search provider?",
      choices: [
        { title: "duckduckgo (no key, unofficial scrape)", value: "duckduckgo" },
        { title: "brave (needs API key, free tier 2k/mo)", value: "brave" },
        { title: "none (disable web_search)", value: "none" },
      ],
      initial: 0,
    });
    const provider = choice.provider as "duckduckgo" | "brave" | "none" | undefined;
    if (!provider) throw new Error("cancelled");

    if (provider === "none") {
      await persistChannelConfig({
        configPath: ctx.configPath,
        envPath: ctx.envPath,
        envUpdates: {},
        yamlEdits: [{ keyPath: ["web", "search", "provider"], value: "none" }],
        channelId: "web.search",
      });
      return;
    }

    if (provider === "duckduckgo") {
      // Validate by hitting the endpoint with a benign query.
      try {
        process.stdout.write("validating duckduckgo… ");
        const dd = new DuckDuckGoProvider();
        const r = await dd.search("daedalus runner test", { limit: 1 });
        process.stdout.write(`OK (${r.length} result${r.length === 1 ? "" : "s"})\n`);
      } catch (err) {
        process.stdout.write("FAILED\n");
        const cont = await confirm(
          `DuckDuckGo failed (${(err as Error).message}). Save anyway? (you can fix later)`,
          false,
        );
        if (!cont) throw new Error("cancelled");
      }
      await persistChannelConfig({
        configPath: ctx.configPath,
        envPath: ctx.envPath,
        envUpdates: {},
        yamlEdits: [{ keyPath: ["web", "search", "provider"], value: "duckduckgo" }],
        channelId: "web.search=duckduckgo",
      });
      return;
    }

    // brave
    console.log("Get a Brave Search API key at https://api.search.brave.com (free tier available).\n");
    const apiKey =
      (await secretPrompt({
        message: "Brave Search API key:",
        validate: (v: string) => v.length > 10 || "key looks too short",
      })) ?? "";
    if (!apiKey) throw new Error("cancelled");

    try {
      process.stdout.write("validating brave key… ");
      const br = new BraveProvider(apiKey);
      const r = await br.search("daedalus runner test", { limit: 1 });
      process.stdout.write(`OK (${r.length} result${r.length === 1 ? "" : "s"})\n`);
    } catch (err) {
      process.stdout.write("FAILED\n");
      throw new Error((err as Error).message);
    }

    await persistChannelConfig({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      envUpdates: { BRAVE_API_KEY: apiKey },
      yamlEdits: [
        { keyPath: ["web", "search", "provider"], value: "brave" },
        { keyPath: ["web", "search", "apiKey"], value: "${BRAVE_API_KEY}" },
      ],
      channelId: "web.search=brave",
    });
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will delete BRAVE_API_KEY and clear web.search config. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }
    await persistChannelDisable({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      channelId: "web.search",
      yamlSets: opts.purge
        ? []
        : [{ keyPath: ["web", "search", "provider"], value: "none" }],
      yamlPurge: [["web", "search"]],
      secretsToPurge: ["BRAVE_API_KEY"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });
  },
};
