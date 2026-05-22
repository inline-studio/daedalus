// Smoke for the new mempalace local-http path. Doesn't drive the interactive setup
// prompts; verifies the data plumbing:
//   1. mempalace.localHttp config is honored by loadConfig (defaults + override)
//   2. Service spec for mempalace reads localHttp + builds a sensible launch line
//   3. Service-install wizard pre-checks mempalace only when localHttp.enabled
//   4. disable mempalace flips localHttp.enabled to false
//   5. disable --purge nukes the whole mempalace block

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { SERVICE_SPECS } from "../dist/service/specs.js";
import { SystemdManager } from "../dist/service/systemd.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = path.join(os.tmpdir(), `dae-mempalace-localhttp-${Date.now()}`);
await fs.mkdir(tmp, { recursive: true });
const cfgPath = path.join(tmp, "daedalus.config.yaml");
const mcpDir = path.join(tmp, "brain", "mcp");
await fs.mkdir(mcpDir, { recursive: true });

await fs.writeFile(
  cfgPath,
  `
brain:
  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}

mcp:
  configPath: ./brain/mcp/servers.json

memory:
  backend: mempalace

mempalace:
  localHttp:
    enabled: true
    command: uvx
    args: [mempalace-mcp, --transport, http, --host, 0.0.0.0, --port, '11364']
    host: 0.0.0.0
    port: 11364
    urlPath: /mcp
`.trim() + "\n",
  "utf8",
);
await fs.writeFile(
  path.join(mcpDir, "servers.json"),
  JSON.stringify(
    {
      mcpServers: {
        mempalace: {
          url: "http://127.0.0.1:11364/mcp",
          transport: "http",
          headers: { Authorization: "Bearer ${MEMPALACE_TOKEN}" },
        },
      },
    },
    null,
    2,
  ),
  "utf8",
);

// 1. Service spec for mempalace builds correctly
{
  const builder = SERVICE_SPECS.mempalace;
  expect("mempalace service spec is registered", typeof builder === "function");
  const spec = await builder(cfgPath);
  expect("spec.name = dae-mempalace", spec.name === "dae-mempalace");
  expect("spec.exec = uvx", spec.exec === "uvx");
  expect("spec.args contains mempalace-mcp", spec.args.includes("mempalace-mcp"));
  expect("spec.args contains --port 11364", spec.args.join(" ").includes("--port 11364"));
  expect("spec.args contains --host 0.0.0.0", spec.args.join(" ").includes("--host 0.0.0.0"));
  expect("spec.restart = on-failure", spec.restart === "on-failure");
  expect("spec.description mentions port", spec.description.includes("11364"));
}

// 2. Systemd renders the unit
{
  const sd = new SystemdManager();
  const builder = SERVICE_SPECS.mempalace;
  const spec = await builder(cfgPath);
  const result = await sd.install(spec, { dryRun: true });
  expect("systemd unit ExecStart references mempalace-mcp", /mempalace-mcp/.test(result.unitContent));
  expect("systemd unit name = dae-mempalace", result.unitPath.endsWith("dae-mempalace.service"));
  expect("systemd Restart=on-failure", /Restart=on-failure/.test(result.unitContent));
  // Crash-loop guard: a bad ExecStart must fail loudly (StartLimit), not spin forever.
  expect("systemd unit has StartLimitBurst rate-limit", /StartLimitBurst=\d+/.test(result.unitContent));
  expect("systemd unit has StartLimitIntervalSec", /StartLimitIntervalSec=\d+/.test(result.unitContent));
}

// 3. service-install --list still includes mempalace
const list = spawnSync("node", ["dist/index.js", "service", "install", "--list"], { encoding: "utf8" });
expect("service install --list includes mempalace", /^mempalace$/m.test(list.stdout));

// 4. disable mempalace (default) flips localHttp.enabled to false
const r1 = spawnSync("node", ["dist/index.js", "-c", cfgPath, "disable", "mempalace"], { encoding: "utf8" });
expect("disable mempalace exit 0", r1.status === 0, r1.stderr.split("\n").slice(-3).join(" / "));
const cfg1 = await fs.readFile(cfgPath, "utf8");
expect("yaml: localHttp.enabled = false after default disable", /enabled:\s*false/.test(cfg1));
expect("yaml: mempalace block STILL present after default disable", /^mempalace:/m.test(cfg1));

// 5. disable --purge removes the mempalace block
const r2 = spawnSync(
  "node",
  ["dist/index.js", "-c", cfgPath, "disable", "mempalace", "--purge", "--yes"],
  { encoding: "utf8" },
);
expect("disable --purge exit 0", r2.status === 0, r2.stderr.split("\n").slice(-3).join(" / "));
const cfg2 = await fs.readFile(cfgPath, "utf8");
expect("yaml: mempalace block removed by --purge", !/^mempalace:/m.test(cfg2));

// 6. Service spec refuses cleanly when localHttp.enabled is false
{
  await fs.writeFile(
    cfgPath,
    `
brain:
  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}

mempalace:
  localHttp:
    enabled: false
`.trim() + "\n",
    "utf8",
  );
  const builder = SERVICE_SPECS.mempalace;
  let threw = null;
  try {
    await builder(cfgPath);
  } catch (e) {
    threw = e;
  }
  expect("spec throws when localHttp.enabled=false", threw !== null);
  expect("error message hints at the fix", /local-http/.test(threw?.message ?? ""));
}

await fs.rm(tmp, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
