import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import prompts from "prompts";
import { buildServiceManager } from "../service/factory.js";
import { SERVICE_SPECS } from "../service/specs.js";
import { ServiceUnsupported } from "../service/base.js";
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

// Whisper / transcription setup.
//
// Architecture: the runtime has a single Transcriber abstraction (src/attachments/transcribe.ts)
// that speaks the OpenAI /v1/audio/transcriptions shape. Both api.openai.com and self-hosted
// servers (faster-whisper-server, whisper.cpp's --api mode, LocalAI, …) implement that shape,
// so "local" and "openai" differ only in baseUrl + apiKey, not in implementation.

const WHISPER_DOCKER_IMAGE = "fedirz/faster-whisper-server:latest";

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

function portFromUrl(url: string): number {
  try {
    return parseInt(new URL(url).port || "8000", 10);
  } catch {
    return 8000;
  }
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

// ── uv install ────────────────────────────────────────────────────────────────

// Known locations the uv installer drops the binary.
const UV_CANDIDATES = [
  path.join(os.homedir(), ".local", "bin", "uv"),
  path.join(os.homedir(), ".cargo", "bin", "uv"),
];

async function findUvBin(): Promise<string | null> {
  if (await isOnPath("uv")) return "uv";
  for (const p of UV_CANDIDATES) {
    try {
      await execa(p, ["--version"], { timeout: 5_000 });
      return p;
    } catch {}
  }
  return null;
}

async function installUv(): Promise<string | null> {
  console.log("Installing uv (Python package manager)…");
  try {
    await execa("sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"], {
      stdio: "inherit",
    });
    return await findUvBin();
  } catch (err) {
    console.warn(`uv install failed: ${(err as Error).message}`);
    return null;
  }
}

// ── host mode helpers ─────────────────────────────────────────────────────────

async function ensureFasterWhisperInstalled(): Promise<boolean> {
  const haveServer =
    (await isOnPath("faster-whisper-server")) || (await isOnPath("whisper-server"));
  if (haveServer) return true;

  // Find or install uv.
  let uvBin = await findUvBin();
  if (!uvBin) {
    if (await isOnPath("pipx")) {
      console.log("Installing faster-whisper-server via pipx…\n");
      try {
        await execa("pipx", ["install", "faster-whisper-server"], { stdio: "inherit" });
        console.log("\n✓ install complete");
        return true;
      } catch (err) {
        console.warn(`\nInstall failed: ${(err as Error).message}`);
        return false;
      }
    }
    // No uv, no pipx — auto-install uv first.
    console.log("Neither uv nor pipx found — installing uv automatically.\n");
    uvBin = await installUv();
    if (!uvBin) {
      console.warn(
        "Could not install uv. Install it manually from https://docs.astral.sh/uv/ and rerun setup.",
      );
      return false;
    }
    console.log();
  }

  console.log("Installing faster-whisper-server via uv…\n");
  try {
    await execa(uvBin, ["tool", "install", "faster-whisper-server"], { stdio: "inherit" });
    console.log("\n✓ install complete");
    return true;
  } catch (err) {
    console.warn(`\nInstall failed: ${(err as Error).message}`);
    return false;
  }
}

function startHostServer(port: number) {
  const proc = execa("faster-whisper-server", ["--host", "127.0.0.1", "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  proc.unref();
  return proc;
}

// ── docker mode helpers ───────────────────────────────────────────────────────

async function startDockerContainer(port: number): Promise<string | null> {
  try {
    const result = await execa("docker", [
      "run",
      "-d",
      "--rm",
      "-p",
      `${port}:8000`,
      WHISPER_DOCKER_IMAGE,
    ]);
    return result.stdout.trim(); // container ID
  } catch (err) {
    console.warn(`docker run failed: ${(err as Error).message}`);
    return null;
  }
}

async function stopDockerContainer(containerId: string): Promise<void> {
  try {
    await execa("docker", ["stop", containerId], { timeout: 15_000 });
  } catch {}
}

// ── service install ───────────────────────────────────────────────────────────

async function installManagedService(configPath: string | undefined): Promise<void> {
  console.log("Installing faster-whisper-server as a managed service…");
  try {
    const manager = await buildServiceManager();
    const specBuilder = SERVICE_SPECS["whisper"];
    if (!specBuilder) throw new Error("whisper service spec not found");
    const spec = await specBuilder(configPath);
    const result = await manager.install(spec);
    for (const note of result.notes) console.log(note);
    console.log("✓ Service installed — faster-whisper-server will start automatically on boot.\n");
  } catch (err) {
    if (err instanceof ServiceUnsupported) {
      console.log(
        "Managed services are not supported on this platform.\n" +
          "Start the server manually after a reboot, or retry with:\n\n" +
          "  dae service install whisper\n",
      );
    } else {
      console.warn(`Service install failed: ${(err as Error).message}`);
      console.log("You can retry later with:\n\n  dae service install whisper\n");
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

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
        { title: "local (self-hosted — free; installed and started automatically)", value: "local" },
      ],
      initial: 0,
    });
    const mode = (modeRes.mode as "openai" | "local" | undefined) ?? null;
    if (!mode) throw new Error("cancelled");

    let baseUrl: string;
    let apiKeyValue: string | undefined;
    let apiKeyEnvName: string | undefined;
    let model: string;
    let runMode: "host" | "docker" = "host";

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
      // ─── local ─────────────────────────────────────────────────────────────────

      const runModeRes = await prompts({
        type: "select",
        name: "runMode",
        message: "Run faster-whisper-server on the host or in Docker?",
        choices: [
          {
            title: "host  (installed via uv — simpler, GPU support via CUDA drivers)",
            value: "host",
          },
          {
            title: "docker (pulled from Docker Hub — isolated, needs Docker installed)",
            value: "docker",
          },
        ],
        initial: 0,
      });
      runMode = (runModeRes.runMode as "host" | "docker" | undefined) ?? "host";

      const urlRes = await prompts({
        type: "text",
        name: "url",
        message: "Server URL (the OpenAI-shaped /v1 endpoint):",
        initial: `http://${runtimeHost(ctx.configPath)}:8000/v1`,
        validate: (v: string) => /^https?:\/\//.test(v) || "must be an http(s) URL",
      });
      baseUrl = (urlRes.url as string | undefined)?.trim() ?? "";
      if (!baseUrl) throw new Error("cancelled");

      const port = portFromUrl(baseUrl);
      const alreadyUp = (await probeOpenAIShape(baseUrl)) === null;

      if (alreadyUp) {
        console.log("  (server already running — skipping install and start)");
      } else if (runMode === "docker") {
        if (!(await isOnPath("docker"))) {
          console.warn(
            "Docker is not on PATH. Install Docker from https://docs.docker.com/get-docker/\n" +
              "then rerun this setup.",
          );
          const cont = await confirm("Continue and save config anyway?", false);
          if (!cont) throw new Error("cancelled");
        } else {
          console.log(`\nPulling and starting ${WHISPER_DOCKER_IMAGE} on port ${port}…`);
          const containerId = await startDockerContainer(port);
          if (containerId) {
            const ready = await waitForServer(baseUrl);
            if (!ready) {
              const cont = await confirm(
                "Container didn't respond in time. Save config anyway?",
                true,
              );
              if (!cont) {
                await stopDockerContainer(containerId);
                throw new Error("cancelled");
              }
            }
            // Hand off to the managed service — stop our temporary container first.
            await stopDockerContainer(containerId);
          }
        }
      } else {
        // host mode
        const installed = await ensureFasterWhisperInstalled();
        if (!installed) {
          const cont = await confirm("Continue and save config anyway? (install manually later)", true);
          if (!cont) throw new Error("cancelled");
        } else {
          console.log(`\nStarting faster-whisper-server on port ${port}…`);
          const proc = startHostServer(port);
          const ready = await waitForServer(baseUrl);
          if (!ready) {
            const cont = await confirm(
              "Server didn't come up in time. Save config anyway?",
              true,
            );
            if (!cont) throw new Error("cancelled");
          }
          // Kill our temporary process — the managed service will start its own.
          proc.kill();
          await new Promise((r) => setTimeout(r, 500));
        }
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
    if (mode === "local") {
      yamlEdits.push({ keyPath: ["transcribe", "runMode"], value: runMode });
      // Local servers usually ignore the apiKey but the SDK requires a value.
      yamlEdits.push({ keyPath: ["transcribe", "apiKey"], value: "local-no-auth-required" });
    } else if (apiKeyEnvName) {
      yamlEdits.push({ keyPath: ["transcribe", "apiKey"], value: `\${${apiKeyEnvName}}` });
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

    // Auto-install the managed service so faster-whisper-server survives reboots.
    // Config must be persisted first — the service spec reads from it.
    if (mode === "local") {
      await installManagedService(ctx.configPath);
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
