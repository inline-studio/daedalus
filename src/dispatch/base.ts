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
export interface DispatchArgs {
  agentName: string;
  // The session this turn belongs to. The dispatcher reads the full history tail
  // from this session and appends new messages back to it.
  sessionId: string;
  userId: string;
  // Sets the system-prompt voice ("you're operating as a subagent…"). Subagent
  // dispatches always pass true; top-level channel dispatches pass false.
  isSubagent: boolean;
  // Optional caller-provided timeout in ms. Container dispatcher hard-kills the
  // container after this; in-process dispatcher ignores (kernel has its own).
  timeoutMs?: number;
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
  | { status: "complete"; finalText: string; turns: number; attachments?: OutboundAttachment[] }
  | { status: "pending_question"; question: string; turns: number };

export interface AgentDispatcher {
  readonly id: string;
  dispatch(args: DispatchArgs): Promise<DispatchResult>;
}
