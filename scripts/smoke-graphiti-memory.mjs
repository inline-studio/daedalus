// Smoke for the Graphiti memory wiring: when memory is configured as graphiti, the agent's
// `memory` MCP slot is auto-injected pointing at the graphiti container; otherwise not.

import { resolveAgentMcpDefs } from "../dist/mcp/agent-mcp.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const cfg = (over) => ({
  mcp: {},
  mempalace: { localHttp: { enabled: false } },
  graphiti: { enabled: false, url: "http://graphiti:8000/mcp/" },
  ...over,
});

// 1. graphiti enabled → memory injected at the graphiti URL (http transport).
{
  const defs = await resolveAgentMcpDefs(cfg({ graphiti: { enabled: true, url: "http://graphiti:8000/mcp/" } }), []);
  expect(
    "graphiti enabled → memory slot points at graphiti",
    !!defs.memory && defs.memory.url === "http://graphiti:8000/mcp/" && defs.memory.transport === "http",
    JSON.stringify(defs.memory),
  );
}

// 2. nothing enabled → no memory slot.
{
  const defs = await resolveAgentMcpDefs(cfg(), []);
  expect("no backend → no memory slot", !defs.memory);
}

// 3. graphiti takes precedence over mempalace when both are enabled.
{
  const defs = await resolveAgentMcpDefs(
    cfg({
      graphiti: { enabled: true, url: "http://graphiti:8000/mcp/" },
      mempalace: { localHttp: { enabled: true, host: "mempalace", port: 11364, urlPath: "/mcp" } },
    }),
    [],
  );
  expect("graphiti wins over mempalace", !!defs.memory && defs.memory.url === "http://graphiti:8000/mcp/");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
