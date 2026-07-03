import readline from "node:readline";
import type { Channel, ChannelContext, OutgoingMessage } from "./base.js";
import type { TurnEventSink } from "../types.js";

// Interactive CLI channel — one user, one terminal. Each line of stdin becomes a message.
// Outbound goes to stdout. Treats the local terminal user as a single fixed external id.
export class CliChannel implements Channel {
  readonly id = "cli";
  readonly defaultAgent: string;
  private rl: readline.Interface | null = null;
  private externalUser = "local";
  // Live subagent verbosity: "summary" (spawn/tool/completion lines), "full" (+ each
  // subagent's final reply text), "off" (spawns stay opaque).
  private subagentEvents: "summary" | "full" | "off";

  constructor(opts: { defaultAgent: string; subagentEvents?: "summary" | "full" | "off" }) {
    this.defaultAgent = opts.defaultAgent;
    this.subagentEvents = opts.subagentEvents ?? "summary";
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(`[cli] connected. Type a message and press enter. Ctrl-C to exit.\n> `);
    this.rl.on("line", async (line) => {
      const text = line.trim();
      if (!text) {
        process.stdout.write("> ");
        return;
      }
      await ctx.publish({
        channel: this.id,
        externalUserId: this.externalUser,
        text,
        receivedAt: new Date().toISOString(),
      });
    });
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  async send(_externalUserId: string, msg: OutgoingMessage): Promise<void> {
    if (msg.text) process.stdout.write(`\n${msg.text}\n`);
    for (const a of msg.attachments ?? []) {
      // A terminal can't render the bytes — note them so the user knows they'd be sent.
      process.stdout.write(`[attachment: ${a.filename ?? "file"} (${a.mediaType}, ${a.data.length} bytes)]\n`);
    }
    process.stdout.write("> ");
  }

  // Live rendering: stream tokens straight to stdout. Reasoning is dimmed and prefixed; tool calls
  // get a one-line marker; turn_complete restores the prompt. Because this rendered the reply, the
  // supervisor skips the buffered final-text send() for a completed turn.
  streamSink(): TurnEventSink {
    let inThinking = false;
    const endThinking = () => {
      if (inThinking) {
        process.stdout.write("\x1b[0m\n");
        inThinking = false;
      }
    };
    return (ev) => {
      // Subagent activity (origin-tagged events) prints as dim prefixed lines — handled
      // BEFORE the switch so a subagent's text_delta never streams into the top-level reply.
      if (ev.origin) {
        if (this.subagentEvents === "off") return;
        const label = ev.origin.path.join(" › ");
        const line = (s: string) => {
          endThinking();
          process.stdout.write(`\x1b[2m[${label}] ${s}\x1b[0m\n`);
        };
        switch (ev.type) {
          case "subagent_start":
            line(`⚙ started: ${clip(ev.prompt, 100)}`);
            break;
          case "tool_use":
            line(`tool: ${ev.name}`);
            break;
          case "subagent_end":
            line(
              ev.status === "complete"
                ? "done"
                : ev.status === "pending_question"
                  ? "needs input"
                  : "failed",
            );
            break;
          case "turn_complete":
            if (this.subagentEvents === "full" && ev.finalText) {
              line(`reply: ${clip(ev.finalText, 300)}`);
            }
            break;
        }
        return;
      }
      switch (ev.type) {
        case "thinking_delta":
          if (!inThinking) {
            process.stdout.write("\n\x1b[2m💭 ");
            inThinking = true;
          }
          process.stdout.write(ev.text);
          break;
        case "text_delta":
          endThinking();
          process.stdout.write(ev.text);
          break;
        case "tool_use":
          endThinking();
          process.stdout.write(`\n\x1b[2m[tool: ${ev.name}]\x1b[0m\n`);
          break;
        case "debug_log":
          endThinking();
          process.stdout.write(`\n\x1b[2m[debug log: ${ev.path}]\x1b[0m\n`);
          break;
        case "turn_complete":
          endThinking();
          process.stdout.write("\n> ");
          break;
      }
    };
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}
