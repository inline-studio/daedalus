import readline from "node:readline";
import {
  type RemoteProfile,
  createSession,
  consumeSse,
  startExecutor,
  fetchers,
  sendMessage,
  abortTurn,
} from "./remote-shared.js";

// Plain line-mode `dae remote` client — the --plain / piped / no-TTY renderer. The full
// terminal interface lives in remote-tui.ts; both share the transport, executor, and
// policy in remote-shared.ts. Without a TTY this runs executor-only: chat from another
// surface, and anything that would have prompted for confirmation is refused.

// Re-exported so existing tests (and any callers) keep importing from this module.
export { evaluateCommand, allowPrefixFor, confineToWorkspace } from "./remote-shared.js";

export interface RemoteClientOptions {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  workspace: string;
  yolo: boolean;
  externalUserId?: string;
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export async function runRemoteClient(opts: RemoteClientOptions): Promise<void> {
  const session = await createSession(opts);
  const profileish: Pick<RemoteProfile, "workspace" | "approval"> = {
    workspace: opts.workspace,
    approval: opts.yolo ? "yolo" : "ask",
  };

  process.stdout.write(
    `[dae remote] server: ${session.base}\n` +
      `[dae remote] user: ${session.externalUserId} · workspace: ${profileish.workspace}` +
      `${opts.yolo ? " · YOLO (exec auto-approved)" : ""}\n`,
  );

  // Interactive terminals get the REPL + confirmation prompts; headless runs are
  // executor-only and refuse anything that would have prompted.
  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let asking = false;
  const ask = (q: string): Promise<string> => {
    if (!rl) return Promise.resolve("n");
    return new Promise((resolve) => {
      asking = true;
      rl.question(q, (answer) => {
        asking = false;
        resolve(answer.trim().toLowerCase());
      });
    });
  };
  const prompt = () => {
    if (interactive && !asking) process.stdout.write("> ");
  };

  let execMode: "local" | "server" = "local";

  // --- Executor ---
  startExecutor({
    session,
    workspace: opts.workspace,
    yolo: opts.yolo,
    callbacks: {
      output: (line) => process.stdout.write(dim(`\n${line}\n`)),
      confirm: async (cmd, danger, allowAlways) => {
        const dangerTag = danger ? " \x1b[31m[DANGEROUS]\x1b[0m" : "";
        const answer = await ask(`\n[exec]${dangerTag} ${cmd}\n  run this? [y/N${allowAlways ? "/a=always" : ""}] `);
        prompt();
        if (answer === "y" || answer === "yes") return "yes";
        if (answer === "a" && allowAlways) return "always";
        return "no";
      },
    },
    onState: (state, detail) => {
      if (state === "reconnecting") {
        process.stdout.write(dim(`\n[executor] disconnected (${detail ?? "?"}) — retrying…\n`));
      }
    },
  });

  // --- Chat stream ---
  let streamedThisTurn = false;
  void consumeSse(
    session,
    `/events?externalUserId=${encodeURIComponent(session.externalUserId)}${session.authQuery}`,
    (event, data) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (event) {
        case "delta":
          streamedThisTurn = true;
          process.stdout.write(String(d.text ?? ""));
          break;
        case "thinking":
          break; // reasoning stays quiet in plain mode
        case "tool":
          process.stdout.write(dim(`\n[tool: ${String(d.name ?? "")}]\n`));
          break;
        case "subagent": {
          const pathArr = Array.isArray(d.path) ? d.path.map(String) : [];
          const label = pathArr.join(" › ") || "subagent";
          if (d.kind === "start") process.stdout.write(dim(`\n[${label}] ⚙ started\n`));
          else if (d.kind === "tool") process.stdout.write(dim(`[${label}] tool: ${String(d.name ?? "")}\n`));
          else if (d.kind === "end") process.stdout.write(dim(`[${label}] ${String(d.status ?? "done")}\n`));
          break;
        }
        case "turn_done":
          if (!streamedThisTurn && d.text) process.stdout.write(`\n${String(d.text)}\n`);
          streamedThisTurn = false;
          process.stdout.write("\n");
          prompt();
          break;
        case "message":
          if (d.text) process.stdout.write(`\n${String(d.text)}\n`);
          prompt();
          break;
      }
    },
    (state, detail) => {
      if (state === "reconnecting") {
        process.stdout.write(dim(`\n[chat] disconnected (${detail ?? "?"}) — retrying…\n`));
      }
    },
  );

  // --- REPL ---
  if (rl) {
    process.stdout.write(`[dae remote] connected — type a message; /help for commands; Ctrl-C to exit\n> `);
    rl.on("line", (line) => {
      void (async () => {
        const text = line.trim();
        if (!text) {
          prompt();
          return;
        }
        if (text === "/help") {
          process.stdout.write(dim("/stop /agents /crons /activity /skills /local on|off — else the message goes to the agent\n"));
          prompt();
          return;
        }
        if (text === "/local on" || text === "/local off") {
          execMode = text.endsWith("on") ? "local" : "server";
          process.stdout.write(dim(`[execution: ${execMode === "local" ? "your machine" : "the server"}]\n`));
          prompt();
          return;
        }
        if (text === "/stop") {
          const stopped = await abortTurn(session);
          process.stdout.write(dim(stopped ? "[stopping…]\n" : "[nothing to stop]\n"));
          prompt();
          return;
        }
        if (text === "/agents") {
          const j = await fetchers.agents(session);
          for (const a of j?.agents ?? []) {
            const bits = [a.model, a.image ? "docker" : null, Array.isArray(a.subagents) && a.subagents.length ? `→ ${(a.subagents as string[]).join(", ")}` : null]
              .filter(Boolean)
              .join(" · ");
            process.stdout.write(`${String(a.name).padEnd(16)} ${dim(String(bits))}\n`);
          }
          if (!j?.agents?.length) process.stdout.write(dim("(no agents)\n"));
          prompt();
          return;
        }
        if (text === "/crons") {
          const j = await fetchers.schedules(session);
          for (const s of j?.static ?? []) {
            process.stdout.write(`${String(s.name).padEnd(24)} ${dim(`${s.schedule} · ${s.agent}${s.enabled ? "" : " · disabled"}`)}\n`);
          }
          for (const d2 of j?.dynamic ?? []) {
            process.stdout.write(`${String(d2.prompt ?? d2.id).slice(0, 40).padEnd(42)} ${dim(`${d2.recurring ?? `next ${d2.nextFire}`} · ${d2.agent}`)}\n`);
          }
          if (!j?.static?.length && !j?.dynamic?.length) process.stdout.write(dim("(nothing scheduled)\n"));
          prompt();
          return;
        }
        if (text === "/activity") {
          const j = await fetchers.activity(session);
          for (const t of j?.turns ?? []) {
            const secs = Math.max(0, Math.floor((Date.now() - Date.parse(String(t.startedAt))) / 1000));
            process.stdout.write(`${String(t.agent).padEnd(14)} ${dim(`${t.activity ?? "working"} · ${t.channel} · ${secs}s`)}\n`);
          }
          if (!j?.turns?.length) process.stdout.write(dim("(idle)\n"));
          prompt();
          return;
        }
        if (text === "/skills") {
          const j = await fetchers.skills(session);
          for (const p of j?.pending ?? []) {
            process.stdout.write(`${String(p.name).padEnd(24)} ${dim(`PENDING (${p.patchesExisting ? "patch" : "new"}) — dae skill approve|reject ${p.name}`)}\n`);
          }
          for (const s of j?.skills ?? []) {
            const marks = [s.origin === "agent" ? "agent" : null, s.status === "stale" ? "stale" : null, s.pinned ? "pinned" : null]
              .filter(Boolean)
              .join(", ");
            process.stdout.write(`${String(s.name).padEnd(24)} ${dim(`${marks ? "[" + marks + "] " : ""}${s.description ?? ""}`)}\n`);
          }
          if (!j?.skills?.length && !j?.pending?.length) process.stdout.write(dim("(no skills)\n"));
          prompt();
          return;
        }
        const res = await sendMessage(session, text, execMode).catch(() => ({ ok: false, status: 0 }));
        if (res.status === 401) process.stdout.write("unauthorized — check the token / login\n");
        else if (!res.ok) process.stdout.write(`send failed (HTTP ${res.status})\n`);
      })();
    });
    rl.on("close", () => {
      process.stdout.write("\n[dae remote] bye\n");
      process.exit(0);
    });
  } else {
    process.stdout.write(
      `[dae remote] no TTY — executor-only mode (chat from another surface; ` +
        `commands needing confirmation are refused${opts.yolo ? "" : "; consider --yolo for trusted setups"})\n`,
    );
  }

  await new Promise(() => {});
}
