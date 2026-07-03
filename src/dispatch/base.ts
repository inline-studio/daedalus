// Dispatcher abstraction.
//
// A *dispatcher* runs one turn of one agent. The caller is responsible for
// persisting the inbound user message into the session store BEFORE dispatching;
// the dispatcher only reads history, runs the kernel, and appends whatever the
// kernel produces back into the session.
//
// Two implementations:
//
//   InProcessAgentDispatcher
//     Runs the kernel in the current Node process. Used by:
//       - `runtime.dispatcher: process` (the default; host-mode operation).
//       - Inside an agent container, when nested subagent calls land back here
//         after the supervisor already forwarded the call across a container hop.
//
//   ContainerAgentDispatcher
//     Spawns a fresh docker container that runs `dae agent-turn` for one turn.
//     Used by:
//       - The supervisor, for every inbound channel message.
//       - From inside an agent container, when the kernel calls spawn_subagent
//         (the agent container has docker.sock mounted, so it can spawn siblings).
//
// Both implementations share a normalized DispatchArgs/DispatchResult contract so
// the kernel doesn't care which one it's behind.
import type { TurnEventSink } from "../types.js";

export interface DispatchArgs {
  agentName: string;
  // The session this turn belongs to. The dispatcher reads the full history tail
  // from this session and appends new messages back to it.
  sessionId: string;
  userId: string;
  // Sets the system-prompt voice ("you're operating as a subagent…"). Subagent
  // dispatches always pass true; top-level channel dispatches pass false.
  isSubagent: boolean;
  // Origin identity of the user this turn runs on behalf of: the channel +
  // external id the inbound arrived on. Threaded into ToolContext so tools that
  // arm future deliveries (schedule_message) can route them back to the real
  // user. Optional — synthetic/cron paths may omit them.
  originChannel?: string;
  originExternalUserId?: string;
  // Optional caller-provided timeout in ms. Container dispatcher hard-kills the
  // container after this; in-process dispatcher ignores (kernel has its own).
  timeoutMs?: number;
  // Ephemeral per-turn directive (a matched skill trigger's inlined instructions). A plain
  // string, so it crosses the container/worker hop. The turn injects it into the model's view of
  // the last user message for THIS turn only — it is never persisted (see IngestResult).
  turnDirective?: string;
  // Optional live turn-event sink. The in-process dispatcher forwards it directly; the
  // persistent worker forwards events over its NDJSON HTTP stream; the one-shot container
  // dispatcher forwards sentinel-framed event lines from the container's stdout. All three
  // deliver the same TurnEvents, so streaming surfaces work regardless of dispatch mode.
  onEvent?: TurnEventSink;
}

// A file the agent attached to its reply (via the `attach_to_reply` tool). Carried as a
// content-addressable ref into the AttachmentStore (which lives on the shared /data
// volume), so it survives the worker→supervisor hop without shipping bytes over the
// dispatcher's HTTP/stdout. The supervisor resolves the ref and hands the bytes to the
// channel for upload.
export interface OutboundAttachment {
  ref: string; // "sha256:<hex>" into the AttachmentStore
  mediaType: string;
  filename?: string;
  caption?: string;
}

export type DispatchResult =
  | {
      status: "complete";
      finalText: string;
      turns: number;
      attachments?: OutboundAttachment[];
      // User-facing notices to deliver alongside the reply (e.g. a compaction notice).
      notices?: string[];
      // Surfaced model reasoning, as standalone "💭" messages — for BUFFERED channels only.
      // Streaming channels render thinking inline (via turn events), so serve drops these there to
      // avoid a double render.
      thinkingMessages?: string[];
      // Path to this turn's conversation debug-log file, set only when debug logging is enabled
      // (config.debug.conversationLog) and only on the TOP-LEVEL turn. Surfaced to the operator
      // after the reply so they know where to look; subagent turns log but don't surface.
      debugLogPath?: string;
    }
  | {
      status: "pending_question";
      question: string;
      turns: number;
      notices?: string[];
      thinkingMessages?: string[];
      debugLogPath?: string;
    };

export interface AgentDispatcher {
  readonly id: string;
  // True when this dispatcher honors DispatchArgs.onEvent (forwards live turn events to the
  // caller). All three implementations now do — in-process directly, the persistent worker over
  // its NDJSON HTTP stream, the one-shot container via sentinel-framed stdout event lines. serve
  // uses this to decide whether to engage a channel's streaming sink.
  readonly streaming?: boolean;
  dispatch(args: DispatchArgs): Promise<DispatchResult>;
}

// BUG-01: the one-shot `dae agent-turn` container prints its DispatchResult on stdout; the
// container dispatcher parses it back. To keep that control channel unforgeable and
// unambiguous (vs. arbitrary JSON / startup noise that may land on stdout), the result line is
// framed with this sentinel and the parser accepts ONLY a sentinel-framed line. Shared between
// the entrypoint (src/index.ts) and the parser (dispatch/container.ts).
export const DISPATCH_RESULT_SENTINEL = "__DAE_DISPATCH_RESULT__ ";

// Same framing idea for LIVE turn events crossing the container hop: when the dispatcher asks
// for streaming (DAE_EVENT_STREAM=ndjson), the agent-turn entrypoint writes each TurnEvent as a
// sentinel-framed JSON line on stdout as the turn unfolds, and the container dispatcher parses
// those lines and forwards them to DispatchArgs.onEvent. Events are display-facing chrome, not
// control flow — a forged or garbled event line can at worst mislabel UI activity; the turn's
// RESULT still only ever comes from the DISPATCH_RESULT_SENTINEL line.
export const DISPATCH_EVENT_SENTINEL = "__DAE_TURN_EVENT__ ";

// IMP-02: the optional origin identity (channel + external user id) is threaded into several
// dispatch payloads (in-process, persistent worker, agent-worker) the same way; build it once,
// including only the keys that are set.
export function originFields(
  args: DispatchArgs,
): { originChannel?: string; originExternalUserId?: string } {
  return {
    ...(args.originChannel ? { originChannel: args.originChannel } : {}),
    ...(args.originExternalUserId ? { originExternalUserId: args.originExternalUserId } : {}),
  };
}
