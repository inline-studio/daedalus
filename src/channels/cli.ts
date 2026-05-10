import readline from "node:readline";
import type { Channel, ChannelContext, OutgoingMessage } from "./base.js";

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
    if (msg.text) process.stdout.write(`\n${msg.text}\n> `);
  }
}
