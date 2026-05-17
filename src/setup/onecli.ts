import prompts from "prompts";
import {
  backendForDisable,
  confirm,
  persistChannelConfig,
  persistChannelDisable,
  runtimeHost,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
} from "./base.js";
import { OneCliSecretsBackend } from "../secrets/store/onecli-backend.js";

// Probes a base URL to confirm OneCLI is up. Returns null on success, an error message
// on failure. We accept any HTTP response (even 404) as proof of life — only network
// errors mean OneCLI isn't running there.
async function probe(baseUrl: string, token?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(baseUrl, { method: "GET", headers });
    if (res.status >= 500) return `HTTP ${res.status}`;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export const onecliSetup: ChannelSetup = {
  id: "onecli",
  title: "OneCLI proxy + secrets backend",
  summary:
    "Enable OneCLI for credential injection (proxy on localhost:10255 swaps placeholders for real keys at the network edge) AND make it the default secrets backend.",

  async run(ctx: SetupContext): Promise<void> {
    console.log(`\n${this.title} setup\n`);
    console.log("OneCLI does two things for the runner:");
    console.log("  1. Proxy: agents send placeholder API keys; OneCLI swaps in real ones at");
    console.log("     the edge. The runner never sees real credentials.");
    console.log("  2. Secret store: `dae secret save` writes to OneCLI's vault instead of");
    console.log("     a plaintext .env.local.\n");
    console.log("Install: see https://github.com/onecli/onecli (Rust gateway + dashboard).");
    console.log("Defaults assume the standard layout: dashboard 10254, proxy 10255.\n");

    const host = runtimeHost(ctx.configPath);
    const dashRes = await prompts({
      type: "text",
      name: "dashboardUrl",
      message: "OneCLI dashboard URL:",
      initial: `http://${host}:10254`,
    });
    const dashboardUrl = (dashRes.dashboardUrl as string | undefined)?.replace(/\/$/, "") ?? "";
    if (!dashboardUrl) throw new Error("cancelled");

    const proxyRes = await prompts({
      type: "text",
      name: "proxyUrl",
      message: "OneCLI proxy URL:",
      initial: `http://${host}:10255`,
    });
    const proxyUrl = (proxyRes.proxyUrl as string | undefined)?.replace(/\/$/, "") ?? "";
    if (!proxyUrl) throw new Error("cancelled");

    const tokenRes = await prompts({
      type: "password",
      name: "token",
      message: "OneCLI auth token (leave blank if not required):",
    });
    const token = ((tokenRes.token as string | undefined) ?? "").trim();

    // Probe both endpoints so we surface obvious mistakes (typos, OneCLI not started)
    // before writing anything to disk.
    process.stdout.write(`probing dashboard at ${dashboardUrl}… `);
    const dashErr = await probe(dashboardUrl, token || undefined);
    process.stdout.write(dashErr ? `FAILED (${dashErr})\n` : "OK\n");

    process.stdout.write(`probing proxy at ${proxyUrl}… `);
    const proxyErr = await probe(proxyUrl);
    process.stdout.write(proxyErr ? `FAILED (${proxyErr})\n` : "OK\n");

    // Bonus — a quick sanity ping via the typed backend so the user sees the same
    // codepath that `secret save` will hit.
    if (!dashErr) {
      const oneCli = new OneCliSecretsBackend({ baseUrl: dashboardUrl, ...(token ? { token } : {}) });
      const ok = await oneCli.ping();
      console.log(`backend ping: ${ok ? "OK" : "no response"}`);
    }

    if (dashErr || proxyErr) {
      const proceed = await confirm(
        "One or both endpoints didn't respond. Save the config anyway? (Useful if you'll start OneCLI later.)",
        false,
      );
      if (!proceed) throw new Error("cancelled");
    } else {
      const proceed = await confirm("Proceed and enable OneCLI?", true);
      if (!proceed) throw new Error("cancelled");
    }

    const envUpdates: Record<string, string> = {};
    if (token) envUpdates.ONECLI_TOKEN = token;

    const yamlEdits: Array<{ keyPath: string[]; value: unknown }> = [
      // Runtime proxy
      { keyPath: ["onecli", "enabled"], value: true },
      { keyPath: ["onecli", "proxy"], value: proxyUrl },
      // Make OneCLI the default secret store too — that was the user's original intent.
      { keyPath: ["secrets", "backend"], value: "onecli" },
      { keyPath: ["secrets", "onecli", "baseUrl"], value: dashboardUrl },
    ];
    if (token) {
      yamlEdits.push({ keyPath: ["onecli", "token"], value: "${ONECLI_TOKEN}" });
      yamlEdits.push({ keyPath: ["secrets", "onecli", "token"], value: "${ONECLI_TOKEN}" });
    }

    await persistChannelConfig({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      envUpdates,
      yamlEdits,
      channelId: "onecli",
    });

    console.log(
      "\nOneCLI is now the proxy and the default secrets backend.\n" +
        "From now on, `dae secret save NAME` will store credentials in OneCLI's vault\n" +
        "and pass injection metadata (urlPattern, agent, headerName, valueFormat) along.\n" +
        "Outbound HTTP from agents routes through " +
        proxyUrl +
        ".\n",
    );
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will delete the saved OneCLI token and remove all onecli/secrets config. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }
    // Disabling OneCLI flips the runtime proxy off AND restores env-file as the default
    // secrets backend (a graceful, always-available fallback). Purging additionally
    // removes the entire onecli + secrets blocks and deletes the saved token.
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
      secretsToPurge: ["ONECLI_TOKEN"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });
  },
};
