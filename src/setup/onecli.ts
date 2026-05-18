import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import prompts from "prompts";
import { OneCLI } from "@onecli-sh/sdk";
import {
  backendForDisable,
  confirm,
  persistChannelConfig,
  persistChannelDisable,
  runtimeHost,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
  type SetupRunOptions,
} from "./base.js";
import { secretPrompt } from "./secret-prompt.js";

// Tries to extract the daemon API key from the file the `onecli` CLI drops on local installs.
// Format is JSON (`{"apiKey":"oc_..."}`) on newer builds, bare string on older ones.
function readLocalApiKey(): string | undefined {
  const credPath = join(homedir(), ".onecli", "credentials", "api-key");
  if (!existsSync(credPath)) return undefined;
  try {
    const raw = readFileSync(credPath, "utf8").trim();
    if (raw.startsWith("{")) return (JSON.parse(raw) as { apiKey?: string }).apiKey;
    return raw || undefined;
  } catch {
    return undefined;
  }
}

export const onecliSetup: ChannelSetup = {
  id: "onecli",
  title: "OneCLI gateway (credential injection)",
  summary:
    "Route outbound HTTPS through the OneCLI gateway so credentials are injected on the wire — runner never holds real API keys.",

  async run(ctx: SetupContext, opts: SetupRunOptions = {}): Promise<void> {
    const record = opts.record ?? (() => {});
    console.log(`\n${this.title} setup\n`);
    console.log("OneCLI is a credential-injecting MITM proxy. At startup daedalus fetches");
    console.log("OneCLI's proxy config + CA cert via the SDK, then routes all outbound traffic");
    console.log("through the proxy. OneCLI matches each request against your registered secrets");
    console.log("(by host pattern) and injects the API key. No secrets ever enter daedalus.\n");
    console.log("Install OneCLI: https://github.com/onecli/onecli (Docker compose, dashboard on :10254).\n");

    const host = runtimeHost(ctx.configPath);
    const dashRes = await prompts({
      type: "text",
      name: "baseUrl",
      message: "OneCLI dashboard URL:",
      initial: `http://${host}:10254`,
    });
    const baseUrl = (dashRes.baseUrl as string | undefined)?.replace(/\/$/, "") ?? "";
    if (!baseUrl) throw new Error("cancelled");

    // Daemon API key (oc_...). Default to what the local `onecli` CLI stored.
    const localKey = readLocalApiKey();
    const typedKey = ((await secretPrompt({
      message: localKey
        ? "OneCLI daemon API key (oc_...) — leave blank to use the one in ~/.onecli/credentials/api-key:"
        : "OneCLI daemon API key (oc_...) — find it with `onecli auth api-key`:",
    })) ?? "").trim();
    const apiKey = typedKey || localKey;
    if (!apiKey) throw new Error("cancelled: no API key supplied");

    const idRes = await prompts({
      type: "text",
      name: "identifier",
      message: "Agent identifier in OneCLI (lowercase, dash-separated):",
      initial: "daedalus",
    });
    const identifier = (idRes.identifier as string | undefined)?.trim() ?? "";
    if (!identifier) throw new Error("cancelled");

    // Verify by ensuring the agent exists. ensureAgent is create-or-no-op semantics —
    // if the agent already exists it just returns it. This doubles as a credentials check.
    process.stdout.write(`ensuring agent '${identifier}' on ${baseUrl}… `);
    const onecli = new OneCLI({ url: baseUrl, apiKey });
    let ensured;
    try {
      ensured = await onecli.ensureAgent({ name: "Daedalus", identifier });
      process.stdout.write("OK\n");
    } catch (err) {
      process.stdout.write(`FAILED (${(err as Error).message})\n`);
      const proceed = await confirm(
        "Couldn't verify the agent. Save the config anyway? (Useful if you'll set it up later.)",
        false,
      );
      if (!proceed) throw new Error("cancelled");
    }

    // And a real container-config call — same path daedalus will hit on every run.
    process.stdout.write(`fetching container-config… `);
    try {
      const bundle = await onecli.getContainerConfig(identifier);
      const proxy = bundle.env.HTTPS_PROXY ?? bundle.env.HTTP_PROXY ?? "(none)";
      process.stdout.write(`OK (proxy=${proxy}, CA=${bundle.caCertificate.length}B)\n`);
    } catch (err) {
      process.stdout.write(`FAILED (${(err as Error).message})\n`);
    }

    if (ensured) {
      console.log(
        ensured.created
          ? `\n✓ created agent '${ensured.identifier}' in OneCLI`
          : `\n✓ agent '${ensured.identifier}' already exists in OneCLI (no changes)`,
      );
      record(
        ensured.created
          ? `created agent '${ensured.identifier}' in OneCLI`
          : `agent '${ensured.identifier}' already existed`,
      );
    }

    const proceed = await confirm("Save config and enable OneCLI?", true);
    if (!proceed) throw new Error("cancelled");

    // The daemon key is sensitive — write it to .env.local, reference via ${ONECLI_API_KEY}.
    await persistChannelConfig({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      envUpdates: { ONECLI_API_KEY: apiKey },
      yamlEdits: [
        { keyPath: ["onecli", "enabled"], value: true },
        { keyPath: ["onecli", "baseUrl"], value: baseUrl },
        { keyPath: ["onecli", "agent"], value: identifier },
        { keyPath: ["onecli", "apiKey"], value: "${ONECLI_API_KEY}" },
        // Use OneCLI as the secrets backend too — for `dae secret list`. get/save are
        // unsupported by OneCLI's protocol; manage secrets with `onecli secrets ...` directly.
        { keyPath: ["secrets", "backend"], value: "onecli" },
        { keyPath: ["secrets", "onecli", "baseUrl"], value: baseUrl },
      ],
      channelId: "onecli",
    });

    console.log(
      "\nOneCLI is wired up. From here:\n" +
        "  • Register credentials in OneCLI with `onecli secrets create --name ... --type anthropic --value ... --host-pattern api.anthropic.com`.\n" +
        `  • Assign them to the '${identifier}' agent (or set the agent's secret-mode to 'all').\n` +
        "  • Run `dae run <agent> --prompt ...` — outbound HTTPS goes through OneCLI, credentials are injected on the wire.\n",
    );
    record(`daemon key saved to .env.local as ONECLI_API_KEY`);
    record(`outbound HTTPS now routes through ${baseUrl}`);
    record(`assign secrets to agent '${identifier}' via \`onecli agents set-secrets\``);
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will delete the saved OneCLI API key and remove all onecli/secrets config. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }
    await persistChannelDisable({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      channelId: "onecli",
      yamlSets: opts.purge
        ? []
        : [
            { keyPath: ["onecli", "enabled"], value: false },
            { keyPath: ["secrets", "backend"], value: "env-file" },
          ],
      yamlPurge: [["onecli"], ["secrets", "onecli"], ["secrets", "backend"]],
      secretsToPurge: ["ONECLI_API_KEY", "ONECLI_TOKEN"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });
  },
};
