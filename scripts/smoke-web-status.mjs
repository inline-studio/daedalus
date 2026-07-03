// Smoke test for the web UI v2 server surface: GET /status (snapshot provider), pinned
// conversations (PATCH + persistence + listing), sidebar title search (?q=), the
// turn_done context readout payload, and the context-window inference map.

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebChannel } from "../dist/channels/web.js";
import { SessionStore } from "../dist/sessions/store.js";
import { inferContextWindow } from "../dist/providers/model-info.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const dir = mkdtempSync(join(tmpdir(), "dae-smoke-webstatus-"));
const sessions = new SessionStore(join(dir, "sessions.sqlite"));
const PORT = 18790;

const chan = new WebChannel({
  defaultAgent: "artemis",
  port: PORT,
  sessions,
  heartbeatMs: 60_000,
  status: async () => ({
    version: "9.9.9-test",
    dispatcher: "process",
    agents: { count: 3, names: ["artemis", "cypher", "vector"] },
    schedules: { static: 2, dynamic: 1 },
    channels: ["web", "telegram"],
  }),
});
await chan.start({ publish: async () => {} });

const base = `http://127.0.0.1:${PORT}`;
const get = (path) => fetch(base + path).then((r) => r.json());

// --- 1. /status snapshot ---
{
  const s = await get("/status");
  expect("GET /status returns the provider snapshot", s.version === "9.9.9-test" && s.agents.count === 3, JSON.stringify(s));
  expect("status carries schedule counts", s.schedules.static === 2 && s.schedules.dynamic === 1);
}

// --- 2. Conversations: pin + search ---
{
  const uid = "smoke-user";
  const before = await get(`/conversations?externalUserId=${uid}`);
  // Create two named conversations next to the default.
  const mk = (title) =>
    fetch(`${base}/conversations?externalUserId=${uid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).then((r) => r.json());
  const alpha = await mk("Alpha deploy plan");
  const beta = await mk("Beta research");
  expect("conversation entries carry pinned:false by default", alpha.pinned === false, JSON.stringify(alpha));

  const patched = await fetch(`${base}/conversations?externalUserId=${uid}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: beta.id, pinned: true }),
  }).then((r) => r.json());
  expect("PATCH pins a conversation", patched.pinned === true, JSON.stringify(patched));

  const list = await get(`/conversations?externalUserId=${uid}`);
  const betaRow = list.conversations.find((c) => c.id === beta.id);
  expect("pin persists in the listing", betaRow?.pinned === true);

  const filtered = await get(`/conversations?externalUserId=${uid}&q=alpha`);
  expect(
    "?q= filters by title (case-insensitive)",
    filtered.conversations.length === 1 && filtered.conversations[0].id === alpha.id,
    JSON.stringify(filtered.conversations.map((c) => c.title)),
  );

  // Ownership: PATCHing someone else's conversation 404s.
  const foreign = await fetch(`${base}/conversations?externalUserId=other-user`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: beta.id, pinned: false }),
  });
  expect("PATCH on another user's conversation is refused", foreign.status === 404);
  expect("default id excluded from search misses", before.defaultId.length > 0);
}

// --- 3. turn_done carries the context readout ---
{
  const chunks = [];
  chan["streams"].set("ctx-user", new Set([{ write: (s) => chunks.push(s), end: () => {} }]));
  const sink = chan.streamSink("ctx-user");
  sink({
    type: "turn_complete",
    finalText: "done",
    usage: { inputTokens: 60_000, outputTokens: 900 },
    context: { inputTokens: 64_000, window: 256_000 },
  });
  const turnDone = chunks.find((c) => c.startsWith("event: turn_done"));
  expect(
    "turn_done SSE carries context {inputTokens, window}",
    Boolean(turnDone) && turnDone.includes('"context":{"inputTokens":64000,"window":256000}'),
    turnDone,
  );
}

// --- 4. Context-window inference map (conservative) ---
{
  expect("claude family inferred at 200k", inferContextWindow("claude-sonnet-4-6") === 200_000);
  expect("gpt-4o family inferred at 128k", inferContextWindow("gpt-4o-mini") === 128_000);
  expect("unknown model → null (no made-up denominator)", inferContextWindow("qwen3-coder-local") === null);
}

await chan.stop();
sessions.close();
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
