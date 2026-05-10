import prompts from "prompts";
import { loadConfig } from "../config/load.js";
import type { ServiceManager } from "./base.js";
import { SERVICE_SPECS } from "./specs.js";

// Pre-check rules — which specs should be selected by default in the wizard.
// 'daedalus' is always pre-selected (the runner itself).
// 'whisper' is pre-selected only when transcribe.backend points at a local instance —
// otherwise installing it would just spin up an unused server.
function defaultSelections(configPath: string | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig(configPath);
  } catch {
    /* config might not exist yet — fine, defaults still apply */
  }
  for (const id of Object.keys(SERVICE_SPECS)) {
    if (id === "daedalus") {
      out[id] = true;
      continue;
    }
    if (id === "whisper") {
      const backend = config?.transcribe.backend;
      const baseUrl = config?.transcribe.baseUrl ?? "";
      out[id] =
        backend === "openai-whisper" &&
        /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/.test(baseUrl);
      continue;
    }
    if (id === "mempalace") {
      // Pre-check only when mempalace was set up in local-http mode. Stdio doesn't need
      // a service (runner manages the subprocess); remote runs elsewhere.
      out[id] = Boolean(config?.mempalace.localHttp.enabled);
      continue;
    }
    out[id] = false;
  }
  return out;
}

export async function runServiceInstallWizard(
  manager: ServiceManager,
  configPath: string | undefined,
  opts: { dryRun?: boolean } = {},
): Promise<void> {
  const selections = defaultSelections(configPath);
  console.log(`Platform: ${manager.platformLabel}\n`);

  const choice = await prompts({
    type: "multiselect",
    name: "picks",
    message: "Pick services to install (space toggles, enter confirms):",
    instructions: false,
    hint: "↑/↓ to move, space to toggle, enter to confirm",
    choices: Object.entries(SERVICE_SPECS).map(([id]) => ({
      title: id,
      value: id,
      selected: selections[id] ?? false,
      description: defaultDescription(id, selections[id] ?? false),
    })),
    min: 0,
  });
  const picks = (choice.picks as string[] | undefined) ?? [];
  if (picks.length === 0) {
    console.log("Nothing selected; nothing to do.");
    return;
  }

  for (const id of picks) {
    const builder = SERVICE_SPECS[id];
    if (!builder) continue;
    console.log(`\n── ${id} ──`);
    const spec = await builder(configPath);
    const result = await manager.install(spec, opts.dryRun ? { dryRun: true } : {});
    if (opts.dryRun) {
      console.log(`\n--- ${result.unitPath} ---`);
      console.log(result.unitContent);
    }
    for (const note of result.notes) console.log(note);
  }
}

function defaultDescription(id: string, selected: boolean): string {
  if (id === "daedalus") return "the runner itself (recommended)";
  if (id === "whisper")
    return selected
      ? "local whisper detected in your config"
      : "skip unless transcribe.baseUrl points at localhost";
  if (id === "mempalace")
    return selected
      ? "mempalace local-http mode configured — daemon will be managed"
      : "skip unless setup mempalace was run in local-http mode";
  return "";
}
