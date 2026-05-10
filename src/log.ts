import pino from "pino";

const level = process.env.DAE_LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug");

// All logs go to stderr (fd 2) so commands like `dae secret get` produce a clean
// stdout that can be composed in shells: `$(dae secret get OPENAI_API_KEY)`.
export const log = pino(
  { level },
  process.stderr.isTTY
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
          destination: 2,
        },
      })
    : pino.destination(2),
);

export type Logger = typeof log;
