// Async-delivery capability per channel.
//
// A *scheduled* fire (schedule_message) delivers its reply to the channel the user armed it
// on. Some channels can push that to the user out of band (Telegram, WhatsApp); others only
// render to a live-connected client and otherwise just persist the message for replay when the
// user next connects (web's SSE, the cli). Arming a recurring "DM me at 7am" on a non-push
// channel therefore fires correctly but never reaches the user — the exact silent failure that
// made two weekends' worth of briefings vanish into the web conversation.
//
// This lives as a central string→bool classifier (not a flag on the Channel interface) on
// purpose: the schedule_message tool runs inside an agent turn that has no channel registry to
// query — it only knows the origin channel *id*. Keep this in sync when adding a channel.
//
// Only channels we KNOW can't push are listed; anything else is assumed push-capable so a new
// channel doesn't trigger spurious warnings. The cost of a wrong guess here is only a heads-up
// line in a tool result, never a blocked schedule.
const NON_PUSH_CHANNELS = new Set(["web", "cli"]);

// True if a scheduled fire on this channel can reach the user when they aren't actively
// connected. False for surfaces that only render to a live client (web, cli).
export function canPushAsync(channelId: string): boolean {
  return !NON_PUSH_CHANNELS.has(channelId);
}
