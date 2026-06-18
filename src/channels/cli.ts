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

  constructor(opts: { defaultAgent: string }) {
    this.defaultAgent = opts.defaultAgent;
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
        case "turn_complete":
          endThinking();
          process.stdout.write("\n> ");
          break;
      }
    };
  }
}
