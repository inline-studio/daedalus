// Smoke for the "copy conversation" feature: the web UI can export the visible chat as an
// attributed, timestamped transcript (Telegram-style `[DD/MM/YYYY HH:MM] Name: text`).
// Covers the three moving parts:
//   - server: /history carries per-message `at` (createdAt); renderShell injects the
//     assistant + user speaker labels (with safe escaping + the right fallbacks).
//   - client: WEB_UI_HTML has the #copychat button, records every message into `convo`,
//     and builds lines via fmtTs/buildTranscript. fmtTs is eval-extracted to check format.

import { WebChannel } from "../dist/channels/web.js";
import { WEB_UI_HTML } from "../dist/channels/web-ui.js";
import { hashPassword } from "../dist/channels/web-auth.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

const ctx = { publish: async () => {} };

// --- 1. /history carries createdAt as `at` ---
{
  const sessions = {
    resolveUser: () => "user-1",
    getOrCreateSession: () => ({ id: "sess-1", userId: "user-1", agentName: "orchestrator" }),
    tail: () => [
      { role: "user", content: [{ type: "text", text: "hello" }], createdAt: "2026-05-27T22:47:00.000Z" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }], createdAt: "2026-05-27T22:48:00.000Z" },
    ],
  };
  const ch = new WebChannel({ defaultAgent: "orchestrator", port: 8811, sessions });
  await ch.start(ctx);
  const hj = await (await fetch("http://127.0.0.1:8811/history?externalUserId=u1")).json();
  ok(
    "/history includes per-message `at` (createdAt) for the transcript",
    hj.messages.length === 2 &&
      hj.messages[0].at === "2026-05-27T22:47:00.000Z" &&
      hj.messages[1].at === "2026-05-27T22:48:00.000Z",
    JSON.stringify(hj.messages),
  );
  await ch.stop();
}

// --- 2. renderShell injects speaker labels (defaults) ---
{
  const ch = new WebChannel({ defaultAgent: "orchestrator", port: 8812 });
  await ch.start(ctx);
  const html = await (await fetch("http://127.0.0.1:8812/")).text();
  ok('default assistant label is "Artemis"', /var ASSISTANT_NAME = "Artemis";/.test(html));
  ok('default user label is "You" (open mode, no config)', /var USER_NAME = "You";/.test(html));
  ok("placeholders are fully substituted (none left raw)", !/__DAE_(ASSISTANT|USER)_NAME__/.test(html));
  await ch.stop();
}

// --- 3. configured assistant + user names are injected and escaped ---
{
  const ch = new WebChannel({
    defaultAgent: "orchestrator",
    port: 8813,
    assistantName: "Artemis",
    userName: 'Scott "the boss" <Jones>',
  });
  await ch.start(ctx);
  const html = await (await fetch("http://127.0.0.1:8813/")).text();
  ok("configured userName is injected", html.includes("var USER_NAME ="));
  ok(
    "userName is escaped for the JS string (quotes escaped, < neutralised)",
    html.includes('Scott \\"the boss\\" \\u003cJones>') && !html.includes('USER_NAME = "Scott "the boss"'),
  );
  ok("no unescaped </script> can be smuggled via a name", !/USER_NAME = "[^"]*<\/script>/.test(html));
  await ch.stop();
}

// --- 4. login mode: user label falls back to the logged-in username when unset ---
{
  const auth = { username: "scott", passwordHash: hashPassword("pw"), sessionSecret: "sek" };
  const ch = new WebChannel({ defaultAgent: "orchestrator", port: 8814, auth });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8814";
  const login = await fetch(base + "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "scott", password: "pw" }),
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const html = await (await fetch(base + "/", { headers: { cookie } })).text();
  ok("login mode without configured userName → label is the logged-in username", /var USER_NAME = "scott";/.test(html));
  await ch.stop();
}

// --- 5. client wiring present in the shell (Telegram-style select mode) ---
{
  ok("select button exists in the header", /id="select"/.test(WEB_UI_HTML));
  ok(
    "selection action bar (Cancel / Select all / Copy) exists",
    /id="selbar"/.test(WEB_UI_HTML) &&
      /id="sel-cancel"/.test(WEB_UI_HTML) &&
      /id="sel-all"/.test(WEB_UI_HTML) &&
      /id="sel-copy"/.test(WEB_UI_HTML),
  );
  ok("a convo record array is declared", /var convo = \[\];/.test(WEB_UI_HTML));
  ok("addMsg records into convo (role/text/at)", /convo\.push\(\{\s*role:[\s\S]*text:[\s\S]*at:/.test(WEB_UI_HTML));
  ok("each bubble is tagged with its convo index (data-idx)", /setAttribute\("data-idx"/.test(WEB_UI_HTML));
  ok("lineFor formats `[ts] Name: text`", /"\[" \+ fmtTs\(m\.at\) \+ "\] " \+ who \+ ": "/.test(WEB_UI_HTML));
  ok(
    "sel-copy builds the selected lines and copies via the shared helper",
    /Array\.from\(selected\)/.test(WEB_UI_HTML) && /copyToClipboard\(text\)/.test(WEB_UI_HTML),
  );
  ok(
    "tapping a bubble in select mode toggles it (and suppresses navigation)",
    /if \(selecting && !onCopyBtn\)/.test(WEB_UI_HTML) && /toggleMsg\(msgEl\)/.test(WEB_UI_HTML),
  );
  ok(
    "history + SSE + send all thread a timestamp into addMsg",
    /addMsg\(m\.role, m\.text \|\| "", m\.attachments \|\| \[\], m\.at\)/.test(WEB_UI_HTML) &&
      /addMsg\("assistant", d\.text \|\| "", d\.attachments \|\| \[\], ev\.lastEventId\)/.test(WEB_UI_HTML) &&
      /addMsg\("user", text, atts, new Date\(\)\.toISOString\(\)\)/.test(WEB_UI_HTML),
  );
}

// --- 5b. native drag-select copy: spanning >1 bubble auto-attributes ---
{
  ok("a document-level copy handler is installed", /document\.addEventListener\("copy"/.test(WEB_UI_HTML));
  ok(
    "single-bubble (or outside) selections fall through to native copy",
    /if \(idxs\.length < 2\) return;/.test(WEB_UI_HTML),
  );
  ok(
    "multi-bubble selections override the clipboard with the attributed transcript",
    /e\.clipboardData\.setData\("text\/plain", text\)/.test(WEB_UI_HTML) && /e\.preventDefault\(\)/.test(WEB_UI_HTML),
  );
  ok(
    "overlap test uses portable boundary-point comparison (no intersectsNode/containsNode calls)",
    /compareBoundaryPoints\(Range\.END_TO_START/.test(WEB_UI_HTML) &&
      /compareBoundaryPoints\(Range\.START_TO_END/.test(WEB_UI_HTML) &&
      !/\.(intersectsNode|containsNode)\(/.test(WEB_UI_HTML),
  );
}

// --- 5c. drag across >1 bubble auto-converts to message selection (the Telegram behaviour) ---
{
  ok("a drag-end (mouseup) handler is installed", /document\.addEventListener\("mouseup"/.test(WEB_UI_HTML));
  ok(
    "drag spanning >=2 bubbles enters select mode and ticks the touched bubbles",
    /if \(!selecting\) enterSelect\(\);/.test(WEB_UI_HTML) &&
      /selected\.add\(i\)[\s\S]{0,160}classList\.add\("selected"\)/.test(WEB_UI_HTML),
  );
  ok(
    "the trailing post-drag click is suppressed (so the bubble isn't toggled back off)",
    /suppressClickUntil = Date\.now\(\)/.test(WEB_UI_HTML) &&
      /Date\.now\(\) < suppressClickUntil/.test(WEB_UI_HTML),
  );
  ok(
    "Cmd/Ctrl+C in select mode copies the ticked transcript, but not from an input/textarea",
    /selecting && selected\.size && !inEditable/.test(WEB_UI_HTML),
  );
  // A visible tick badge (not just the ring, which is invisible on the blue user bubbles).
  ok(
    "selected bubbles get a checkmark badge",
    /\.msg\.selected::after\s*\{[^}]*content:\s*"✓"/.test(WEB_UI_HTML),
  );
  ok(
    "the tick sits in the gutter on both sides (user left, assistant right)",
    /\.msg\.user\.selected::after\s*\{[^}]*left:/.test(WEB_UI_HTML) &&
      /\.msg\.assistant\.selected::after\s*\{[^}]*right:/.test(WEB_UI_HTML),
  );
  ok(
    "the bubble is position:relative so the badge anchors to it",
    /\.msg \{[^}]*position:\s*relative/.test(WEB_UI_HTML),
  );
}

// --- 6. fmtTs produces the DD/MM/YYYY HH:MM shape and tolerates bad input ---
{
  const s = WEB_UI_HTML.indexOf("function pad2(");
  const e = WEB_UI_HTML.indexOf("function lineFor");
  ok("pad2 + fmtTs extractable", s >= 0 && e > s);
  if (s >= 0 && e > s) {
    const api = new Function(WEB_UI_HTML.slice(s, e) + " return { fmtTs: fmtTs, pad2: pad2 };")();
    ok(
      "fmtTs renders DD/MM/YYYY HH:MM (zero-padded)",
      /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(api.fmtTs("2026-05-27T22:47:00.000Z")),
      api.fmtTs("2026-05-27T22:47:00.000Z"),
    );
    ok(
      "fmtTs falls back to a valid timestamp for garbage input (never NaN)",
      /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/.test(api.fmtTs("not-a-date")),
      api.fmtTs("not-a-date"),
    );
  }
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
