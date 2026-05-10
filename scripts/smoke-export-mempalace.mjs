// Smoke for `dae export mempalace`. Verifies all three modes:
//   1. local-stdio → refuses with a useful error
//   2. local-http (0.0.0.0)  → prints LAN URL using hostname (or --host override)
//   3. local-http (127.0.0.1) → prints SSH-tunnel guidance
//   4. remote     → re-prints the configured URL + token

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = path.join(os.tmpdir(), `dae-export-smoke-${Date.now()}`);
await fs.mkdir(tmp, { recursive: true });

async function setup(mode, opts = {}) {
  const dir = path.join(tmp, mode);
  await fs.mkdir(dir, { recursive: true });
  const cfgPath = path.join(dir, "daedalus.config.yaml");
  const mcpDir = path.join(dir, "brain", "mcp");
  await fs.mkdir(mcpDir, { recursive: true });
  const envPath = path.join(dir, ".env.local");

  if (mode === "local-stdio") {
    await fs.writeFile(
      cfgPath,
      `brain:\n  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}\nmcp:\n  configPath: ./brain/mcp/servers.json\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(mcpDir, "servers.json"),
      JSON.stringify({ mcpServers: { mempalace: { command: "uvx", args: ["mempalace-mcp"] } } }, null, 2),
      "utf8",
    );
  } else if (mode === "local-http") {
    const host = opts.host ?? "0.0.0.0";
    const port = 11364;
    await fs.writeFile(
      cfgPath,
      `brain:\n  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}\nmcp:\n  configPath: ./brain/mcp/servers.json\nmempalace:\n  localHttp:\n    enabled: true\n    command: uvx\n    args: [mempalace-mcp]\n    host: ${host}\n    port: ${port}\n    urlPath: /mcp\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(mcpDir, "servers.json"),
      JSON.stringify(
        {
          mcpServers: {
            mempalace: {
              url: `http://127.0.0.1:${port}/mcp`,
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
    await fs.writeFile(envPath, "MEMPALACE_TOKEN=test-token-aaaaaaaa\n", "utf8");
  } else if (mode === "remote") {
    await fs.writeFile(
      cfgPath,
      `brain:\n  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}\nmcp:\n  configPath: ./brain/mcp/servers.json\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(mcpDir, "servers.json"),
      JSON.stringify(
        {
          mcpServers: {
            mempalace: {
              url: "https://mempalace.in-line.studio/mcp",
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
    await fs.writeFile(envPath, "MEMPALACE_TOKEN=remote-token-bbbbbbbb\n", "utf8");
  }
  return cfgPath;
}

function run(cfgPath, ...args) {
  return spawnSync("node", ["dist/index.js", "-c", cfgPath, "export", ...args], { encoding: "utf8" });
}

// 1. local-stdio → error
{
  const cfgPath = await setup("local-stdio");
  const r = run(cfgPath, "mempalace");
  expect("local-stdio: exits non-zero", r.status !== 0);
  expect(
    "local-stdio: error mentions stdio + suggests local-http",
    /local-stdio/.test(r.stderr) && /local-http/.test(r.stderr),
  );
}

// 2. local-http bound 0.0.0.0 → uses hostname
{
  const cfgPath = await setup("local-http", { host: "0.0.0.0" });
  const r = run(cfgPath, "mempalace");
  expect("local-http 0.0.0.0: exit 0", r.status === 0);
  expect("local-http 0.0.0.0: prints local URL", /http:\/\/127\.0\.0\.1:11364\/mcp/.test(r.stdout));
  expect("local-http 0.0.0.0: prints LAN URL with hostname", new RegExp(`http://${os.hostname()}:11364/mcp`).test(r.stdout));
  expect("local-http 0.0.0.0: prints token", /test-token-aaaaaaaa/.test(r.stdout));
  expect("local-http 0.0.0.0: prints paste-ready snippet", /"mcpServers"/.test(r.stdout));
  expect("local-http 0.0.0.0: snippet includes Bearer token", /Bearer test-token-aaaaaaaa/.test(r.stdout));
  expect("local-http 0.0.0.0: includes secret warning", /secret/i.test(r.stdout));
}

// 2b. --host override
{
  const cfgPath = await setup("local-http", { host: "0.0.0.0" });
  const r = run(cfgPath, "mempalace", "--host", "casa.local");
  expect("local-http: --host casa.local appears in snippet", /http:\/\/casa\.local:11364\/mcp/.test(r.stdout));
}

// 3. local-http bound 127.0.0.1 → tunnel guidance
{
  const cfgPath = await setup("local-http", { host: "127.0.0.1" });
  const r = run(cfgPath, "mempalace");
  expect("local-http 127.0.0.1: exit 0", r.status === 0);
  expect("local-http 127.0.0.1: includes tunnel hint", /ssh -L 11364:127\.0\.0\.1:11364/.test(r.stdout));
  expect("local-http 127.0.0.1: notes LAN access disabled", /127\.0\.0\.1.*reach the daemon/.test(r.stdout));
}

// 4. remote → re-prints original URL + token
{
  const cfgPath = await setup("remote");
  const r = run(cfgPath, "mempalace");
  expect("remote: exit 0", r.status === 0);
  expect("remote: prints configured URL", /https:\/\/mempalace\.in-line\.studio\/mcp/.test(r.stdout));
  expect("remote: prints token", /remote-token-bbbbbbbb/.test(r.stdout));
}

// 5. unknown export target → exit 2
{
  const cfgPath = await setup("local-http");
  const r = spawnSync("node", ["dist/index.js", "-c", cfgPath, "export", "nothing"], { encoding: "utf8" });
  expect("unknown target: exit 2", r.status === 2);
}

await fs.rm(tmp, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
