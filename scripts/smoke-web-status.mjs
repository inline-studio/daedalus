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

// --- 5. Viewers + execution flag (WS6d/e) on a second channel instance ---
{
  const PORT2 = 18794;
  const published = [];
  const chan2 = new WebChannel({
    defaultAgent: "artemis",
    port: PORT2,
    sessions,
    heartbeatMs: 60_000,
    remoteExec: { enabled: true, timeoutMs: 2_000 },
    listAgentDetails: async () => [
      { name: "artemis", description: "orchestrator", provider: "openai", model: "m", tools: ["*"], skills: ["*"], subagents: ["cypher"] },
      { name: "cypher", description: "coder", provider: "openai", model: "m", tools: [], skills: [], subagents: [], image: "dev-node" },
    ],
    listSchedules: async () => ({
      static: [{ name: "morning-brief", agent: "artemis", schedule: "0 7 * * *", enabled: true }],
      dynamic: [{ id: "sched_1", agent: "artemis", prompt: "check build", nextFire: "2026-07-04T10:00:00Z", recurring: null, createdBy: "artemis" }],
    }),
  });
  await chan2.start({ publish: async (m) => published.push(m) });
  const base2 = `http://127.0.0.1:${PORT2}`;

  const agents = await fetch(`${base2}/agents`).then((r) => r.json());
  expect("GET /agents returns manifest summaries", agents.agents?.length === 2 && agents.agents[1].image === "dev-node", JSON.stringify(agents));
  expect(
    "GET /agents flags the channel's orchestrator (the UI shows sub-agents only)",
    agents.agents?.[0].orchestrator === true && agents.agents?.[1].orchestrator === undefined,
    JSON.stringify(agents.agents?.map((a) => [a.name, a.orchestrator])),
  );
  const scheds = await fetch(`${base2}/schedules`).then((r) => r.json());
  expect("GET /schedules returns static + dynamic", scheds.static?.length === 1 && scheds.dynamic?.length === 1);

  // Execution flag: valid values pass through to the published message; junk is dropped.
  await fetch(`${base2}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalUserId: "u9", text: "hi", execution: "server" }),
  });
  await fetch(`${base2}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalUserId: "u9", text: "hi", execution: "sideways" }),
  });
  expect("execution: 'server' rides the published message", published[0]?.execution === "server", JSON.stringify(published[0]));
  expect("invalid execution values are dropped", published[1]?.execution === undefined);

  // /status reports per-caller executor state when remoteExec is enabled.
  const st = await fetch(`${base2}/status?externalUserId=u9`).then((r) => r.json());
  expect("status reports executor enabled+disconnected", st.remoteExec?.enabled === true && st.remoteExec?.connected === false, JSON.stringify(st.remoteExec));
  expect("status reports dictation:false without a transcriber", st.dictation === false);
  const noMic = await fetch(`${base2}/transcribe`, { method: "POST", body: JSON.stringify({ audio: "aGk=" }) });
  expect("POST /transcribe 404s without a transcriber", noMic.status === 404);
  await chan2.stop();
}

// --- 4. Dictation: /transcribe + the status flag when a transcriber is wired ---
{
  const PORT3 = 18796;
  let sawMediaType = null;
  const chan3 = new WebChannel({
    defaultAgent: "artemis",
    port: PORT3,
    sessions,
    heartbeatMs: 60_000,
    transcribe: async (audio, mediaType) => {
      sawMediaType = mediaType;
      return audio.toString("utf8") === "hello" ? "transcribed text" : null;
    },
  });
  await chan3.start({ publish: async () => {} });
  const base3 = `http://127.0.0.1:${PORT3}`;

  const st3 = await fetch(`${base3}/status?externalUserId=u1`).then((r) => r.json());
  expect("status reports dictation:true with a transcriber", st3.dictation === true);
  const okRes = await fetch(`${base3}/transcribe`, {
    method: "POST",
    body: JSON.stringify({ audio: Buffer.from("hello").toString("base64"), mediaType: "audio/webm" }),
  });
  const okJson = await okRes.json();
  expect("POST /transcribe decodes + returns the text", okRes.status === 200 && okJson.text === "transcribed text", JSON.stringify(okJson));
  expect("transcriber receives the mediaType", sawMediaType === "audio/webm");
  const badRes = await fetch(`${base3}/transcribe`, { method: "POST", body: JSON.stringify({ audio: "" }) });
  expect("POST /transcribe without audio → 400", badRes.status === 400);
  const failRes = await fetch(`${base3}/transcribe`, {
    method: "POST",
    body: JSON.stringify({ audio: Buffer.from("garble").toString("base64") }),
  });
  expect("transcriber null result → 502", failRes.status === 502);
  await chan3.stop();
}

sessions.close();
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
