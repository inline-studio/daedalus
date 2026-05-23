// Smoke test for the kernel's transient-LLM-error retry.
//
// The LLM call is the only step in the turn loop that can throw and propagate (tool +
// MCP errors are caught and returned to the model). A transient blip there used to
// crash the whole turn. These checks confirm the kernel now retries transient errors
// (429/5xx/network) and still fails fast on permanent ones (401/400).

import { Kernel } from "../dist/kernel/agent.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const okResult = {
  message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
  stopReason: "end_turn",
};

function makeKernel(provider) {
  return new Kernel({
    provider,
    model: "test",
    system: "s",
    builtinTools: [],
    mcpServers: new Map(),
    toolContext: {},
    maxTurns: 3,
    maxTokens: 100,
  });
}

// 1. transient HTTP error (529 overload) → retried, then succeeds
{
  let calls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete() {
      calls++;
      if (calls === 1) {
        const e = new Error("Anthropic completion failed: 529 overloaded_error");
        e.status = 529;
        throw e;
      }
      return okResult;
    },
  };
  const res = await makeKernel(provider).run("hello");
  expect(
    "retries transient 529 then succeeds",
    calls === 2 && res.finalText === "hi",
    `calls=${calls}, text=${res.finalText}`,
  );
}

// 2. permanent error (401) → NOT retried, throws immediately
{
  let calls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete() {
      calls++;
      const e = new Error("Anthropic completion failed: 401 invalid x-api-key");
      e.status = 401;
      throw e;
    },
  };
  let threw = false;
  try {
    await makeKernel(provider).run("hello");
  } catch {
    threw = true;
  }
  expect("does NOT retry permanent 401", threw && calls === 1, `calls=${calls}, threw=${threw}`);
}

// 3. network error with no HTTP status (fetch failed) → retried
{
  let calls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete() {
      calls++;
      if (calls < 2) throw new Error("OpenAI-compatible completion failed: fetch failed");
      return okResult;
    },
  };
  const res = await makeKernel(provider).run("hi");
  expect("retries network error (fetch failed)", calls === 2 && res.finalText === "hi", `calls=${calls}`);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
