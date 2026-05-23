// Smoke test for the persistent (warm worker) dispatch path.
//
// No docker daemon needed: we stand up a fake HTTP "worker" with node:http and point
// PersistentContainerDispatcher at it via DAE_WORKER_URL, then assert:
//   - dispatch() POSTs the turn to /turn with the right body and returns the parsed
//     DispatchResult
//   - a non-OK HTTP response surfaces the worker's error (and is NOT retried)
//   - a connection failure is retried until the worker comes up
//   - the `dae agent-worker` subcommand is registered

import http from "node:http";
import { spawnSync } from "node:child_process";
import { PersistentContainerDispatcher } from "../dist/dispatch/persistent.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Happy path — dispatch posts to /turn and returns the parsed result.
{
  let seenPath = "";
  let seenBody = "";
  const server = http.createServer((req, res) => {
    seenPath = req.url;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "complete", finalText: "hi from worker", turns: 2 }));
    });
  });
  const port = await listen(server);
  process.env.DAE_WORKER_URL = `http://127.0.0.1:${port}`;
  const d = new PersistentContainerDispatcher({});
  const result = await d.dispatch({
    agentName: "artemis",
    sessionId: "s1",
    userId: "u1",
    isSubagent: false,
  });
  expect("POSTs to /turn", seenPath === "/turn", `got ${seenPath}`);
  const parsed = JSON.parse(seenBody || "{}");
  expect(
    "body carries agent/session/user/isSubagent",
    parsed.agentName === "artemis" &&
      parsed.sessionId === "s1" &&
      parsed.userId === "u1" &&
      parsed.isSubagent === false,
    seenBody,
  );
  expect(
    "returns the parsed DispatchResult",
    result.status === "complete" && result.finalText === "hi from worker" && result.turns === 2,
    JSON.stringify(result),
  );
  await close(server);
}

// 2. Non-OK response surfaces the worker error and is NOT retried (fast).
{
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom in the worker" }));
  });
  const port = await listen(server);
  process.env.DAE_WORKER_URL = `http://127.0.0.1:${port}`;
  const d = new PersistentContainerDispatcher({});
  let threw = false;
  let msg = "";
  try {
    await d.dispatch({ agentName: "a", sessionId: "s", userId: "u", isSubagent: false });
  } catch (e) {
    threw = true;
    msg = String(e?.message ?? e);
  }
  expect("HTTP error throws", threw && /boom in the worker/.test(msg), msg);
  expect("HTTP error is not retried (single hit)", hits === 1, `hits=${hits}`);
  await close(server);
}

// 3. Connection failure is retried until the worker comes up.
{
  // Reserve a port, then close it so the first dispatch attempts fail to connect;
  // bring a real server up on the same port shortly after.
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);

  process.env.DAE_WORKER_URL = `http://127.0.0.1:${port}`;
  const d = new PersistentContainerDispatcher({});
  const dispatchPromise = d.dispatch({
    agentName: "a",
    sessionId: "s",
    userId: "u",
    isSubagent: false,
  });

  await delay(1300); // miss the first attempt(s); the dispatcher retries every ~1s
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "complete", finalText: "late", turns: 1 }));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const result = await dispatchPromise;
  expect("retries until worker is reachable", result.finalText === "late", JSON.stringify(result));
  await close(server);
}

// 4. `dae agent-worker --help` is registered.
{
  const help = spawnSync("node", ["dist/index.js", "agent-worker", "--help"], { encoding: "utf8" });
  const out = (help.stdout ?? "") + (help.stderr ?? "");
  expect(
    "dae agent-worker --help is registered",
    /agent-worker/.test(out) && help.status === 0,
    out.slice(0, 200),
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
