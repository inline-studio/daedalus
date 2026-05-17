import type { ChildProcess } from "node:child_process";
import { execa } from "execa";
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

// Whisper / transcription setup.
//
// Architecture: the runtime has a single Transcriber abstraction (src/attachments/transcribe.ts)
// that speaks the OpenAI /v1/audio/transcriptions shape. Both api.openai.com and self-hosted
// servers (faster-whisper-server, whisper.cpp's --api mode, LocalAI, …) implement that shape,
// so "local" and "openai" differ only in baseUrl + apiKey, not in implementation.

async function isOnPath(cmd: string): Promise<boolean> {
  try {
    await execa(cmd, ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    try {
      await execa(cmd, ["--help"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

async function probeOpenAIShape(baseUrl: string, apiKey?: string): Promise<string | null> {
  // GET /v1/models on a whisper-shape endpoint usually returns 200 (or 401 if auth required).
  // We treat any HTTP response below 500 as "alive".
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (res.status === 401 || res.status === 403) return `auth rejected (HTTP ${res.status})`;
    if (res.status >= 500) return `HTTP ${res.status}`;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

interface InstallChoice {
  command: string;
  args: string[];
  hint: string;
}

function portFromUrl(url: string): number {
  try {
    return parseInt(new URL(url).port || "8000", 10);
  } catch {
    return 8000;
  }
}

function startLocalServer(port: number): ChildProcess {
  // Start detached so it outlives setup; caller is responsible for killing it if
  // the user opts to manage it via `dae service install` instead.
  const proc = execa("faster-whisper-server", ["--host", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  return proc as unknown as ChildProcess;
}

async function waitForServer(baseUrl: string, timeoutMs = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("waiting for server to come up (model download may take a few minutes)");
  while (Date.now() < deadline) {
    const err = await probeOpenAIShape(baseUrl);
    if (!err) {
      process.stdout.write(" ready\n");
      return true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3_000));
  }
  process.stdout.write(" timed out\n");
  return false;
}

// Pick an install path for local whisper, preferring uv if present (fastest, isolated venv).
async function suggestInstall(): Promise<InstallChoice | null> {
  if (await isOnPath("uv")) {
    return {
      command: "uv",
      args: ["tool", "install", "faster-whisper-server"],
      hint: "uv tool install faster-whisper-server",
    };
  }
  if (await isOnPath("pipx")) {
    return {
      command: "pipx",
      args: ["install", "faster-whisper-server"],
      hint: "pipx install faster-whisper-server",
    };
  }
  return null;
}

export const whisperSetup: ChannelSetup = {
  id: "whisper",
  title: "Whisper / transcription",
  summary:
    "Wire speech-to-text. Audio attachments (Telegram voice notes, web uploads) get auto-transcribed before the agent sees them.",

  async run(ctx: SetupContext): Promise<void> {
    console.log(`\n${this.title} setup\n`);
    console.log("Audio messages get transcribed before reaching the agent so the model can");
    console.log("read them like text. The runner sends them through one OpenAI-compatible");
    console.log("/v1/audio/transcriptions endpoint — could be api.openai.com or a self-hosted");
    console.log("server (faster-whisper-server, whisper.cpp, etc.).\n");

    const modeRes = await prompts({
      type: "select",
      name: "mode",
      message: "Where should transcription run?",
      choices: [
        { title: "openai (api.openai.com — paid, fast, accurate)", value: "openai" },
        { title: "local (self-hosted — free; needs faster-whisper-server or similar)", value: "local" },
      ],
      initial: 0,
    });
    const mode = (modeRes.mode as "openai" | "local" | undefined) ?? null;
    if (!mode) throw new Error("cancelled");

    let baseUrl: string;
    let apiKeyValue: string | undefined;
    let apiKeyEnvName: string | undefined;
    let model: string;
    let weStartedLocalServer = false;

    if (mode === "openai") {
      baseUrl = "https://api.openai.com/v1";

      const reuse = await confirm(
        "Use the existing OPENAI_API_KEY for whisper? (Otherwise we'll save a separate key.)",
        true,
      );
      if (reuse) {
        apiKeyEnvName = "OPENAI_API_KEY";
        if (!process.env.OPENAI_API_KEY) {
          console.warn(
            "  WARN: OPENAI_API_KEY isn't currently in your env. The runner will resolve it from the\n" +
              "  secrets backend at run time (save it via `dae secret save OPENAI_API_KEY`).",
          );
        }
      } else {
        const r = await prompts({
          type: "password",
          name: "key",
          message: "OpenAI API key (saved separately as WHISPER_OPENAI_API_KEY):",
        });
        apiKeyValue = ((r.key as string | undefined) ?? "").trim();
        if (!apiKeyValue) throw new Error("cancelled");
        apiKeyEnvName = "WHISPER_OPENAI_API_KEY";

        // Validate against the live endpoint — fast feedback on a bad key.
        process.stdout.write("validating with OpenAI… ");
        const err = await probeOpenAIShape(baseUrl, apiKeyValue);
        process.stdout.write(err ? `FAILED (${err})\n` : "OK\n");
        if (err) {
          const ok = await confirm("Save anyway?", false);
          if (!ok) throw new Error("cancelled");
        }
      }

      const modelRes = await prompts({
        type: "text",
        name: "model",
        message: "Whisper model:",
        initial: "whisper-1",
      });
      model = (modelRes.model as string | undefined)?.trim() || "whisper-1";
    } else {
      // ─── local ─────────────────────────────────────────────────────────────────────────
      console.log(
        "Local mode runs an OpenAI-compatible whisper server on this machine. The most\n" +
          "common choice is `faster-whisper-server` (Python, fast, GPU-accelerated when\n" +
          "available). Alternatives: whisper.cpp's `--api` mode, LocalAI, etc.\n",
      );

      // Probe what the user already has.
      const haveServer = (await isOnPath("faster-whisper-server")) || (await isOnPath("whisper-server"));

      if (!haveServer) {
        const install = await suggestInstall();
        if (install) {
          console.log(`No local whisper server found on PATH. Recommended install:\n  ${install.hint}\n`);
          const runIt = await confirm(`Run \`${install.hint}\` now?`, true);
          if (runIt) {
            console.log(`(this can take 1–2 minutes; downloading deps & model files)\n`);
            try {
              await execa(install.command, install.args, { stdio: "inherit" });
              console.log("\n✓ install complete");
            } catch (err) {
              console.warn(`install failed: ${(err as Error).message}`);
              const cont = await confirm("Continue setup anyway? (configure URL; install later)", true);
              if (!cont) throw new Error("cancelled");
            }
          }
        } else {
          console.log(
            "Couldn't find `uv` or `pipx`. Install one of:\n" +
              "  • https://docs.astral.sh/uv/  (recommended)\n" +
              "  • pipx (`python -m pip install --user pipx`)\n" +
              "Then rerun this setup, or install whisper manually.\n",
          );
          const cont = await confirm("Continue and configure the URL anyway?", false);
          if (!cont) throw new Error("cancelled");
        }
      }

      const urlRes = await prompts({
        type: "text",
        name: "url",
        message: "Server URL (the OpenAI-shaped /v1 endpoint):",
        initial: "http://localhost:8000/v1",
        validate: (v: string) => /^https?:\/\//.test(v) || "must be an http(s) URL",
      });
      baseUrl = (urlRes.url as string | undefined)?.trim() ?? "";
      if (!baseUrl) throw new Error("cancelled");

      // Check if something is already listening before we try to start our own instance.
      const alreadyUp = (await probeOpenAIShape(baseUrl)) === null;

      if (!alreadyUp) {
        const port = portFromUrl(baseUrl);
        console.log(`\nStarting faster-whisper-server on port ${port}…`);
        startLocalServer(port);
        weStartedLocalServer = true;
        const ready = await waitForServer(baseUrl);
        if (!ready) {
          const cont = await confirm(
            "Server didn't come up in time. Save config anyway? (you can start it manually later)",
            true,
          );
          if (!cont) throw new Error("cancelled");
        }
      } else {
        console.log("  (server already running — skipping start)");
      }

      // Local servers usually ignore the apiKey but the SDK requires a non-empty value.
      apiKeyValue = "local-no-auth-required";

      const modelRes = await prompts({
        type: "text",
        name: "model",
        message: "Model identifier (server-specific; blank = server's default):",
        initial: "Systran/faster-whisper-large-v3",
      });
      model = (modelRes.model as string | undefined)?.trim() || "Systran/faster-whisper-large-v3";
    }

    const proceed = await confirm(`Proceed and enable whisper (${mode})?`, true);
    if (!proceed) throw new Error("cancelled");

    // Persist: env-var (if separate key), YAML edits.
    const envUpdates: Record<string, string> = {};
    if (apiKeyEnvName === "WHISPER_OPENAI_API_KEY" && apiKeyValue) {
      envUpdates.WHISPER_OPENAI_API_KEY = apiKeyValue;
    }

    const yamlEdits: Array<{ keyPath: string[]; value: unknown }> = [
      { keyPath: ["transcribe", "backend"], value: "openai-whisper" },
      { keyPath: ["transcribe", "baseUrl"], value: baseUrl },
      { keyPath: ["transcribe", "model"], value: model },
    ];
    if (mode === "openai" && apiKeyEnvName) {
      yamlEdits.push({ keyPath: ["transcribe", "apiKey"], value: `\${${apiKeyEnvName}}` });
    } else if (mode === "local") {
      // Hardcode a placeholder; local servers ignore it but the SDK requires a value.
      yamlEdits.push({ keyPath: ["transcribe", "apiKey"], value: "local-no-auth-required" });
    }

    await persistChannelConfig({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      envUpdates,
      yamlEdits,
      channelId: `whisper=${mode}`,
    });

    console.log(
      `\nAudio attachments arriving via any channel will now be auto-transcribed through ${baseUrl}\n` +
        `before the agent sees them. The transcript is also injected as a text part so the agent\n` +
        `can read it directly.\n`,
    );

    if (weStartedLocalServer) {
      console.log(
        "faster-whisper-server is running now, but won't survive a reboot.\n" +
          "To keep it running automatically, install it as a managed service:\n\n" +
          "  dae service install whisper\n",
      );
    }
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will set transcribe.backend = none, remove the transcribe block, and delete the saved key. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }
    await persistChannelDisable({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      channelId: "whisper",
      yamlSets: opts.purge ? [] : [{ keyPath: ["transcribe", "backend"], value: "none" }],
      yamlPurge: [["transcribe"]],
      // Only the separately-saved key gets deleted; OPENAI_API_KEY stays (other features use it).
      secretsToPurge: ["WHISPER_OPENAI_API_KEY"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });

    if (!opts.purge) {
      console.log(
        "\nNote: audio messages will now arrive untranscribed. Some channels (Telegram voice\n" +
          "notes) will still attach the audio bytes; the agent just won't have a text version.\n",
      );
    }
  },
};
