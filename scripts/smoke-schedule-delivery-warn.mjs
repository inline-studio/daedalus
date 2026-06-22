// Scheduled-delivery push capability. A schedule armed on a channel that can't push async
// (web, cli) fires fine but never alerts the user — so schedule_message warns. Exercises the
// canPushAsync classifier the warning is built on.

import { canPushAsync } from "../dist/channels/delivery.js";

let pass = true;
const expect = (label, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) pass = false;
};

// Push-capable: reach the user out of band.
expect("telegram can push", canPushAsync("telegram"));
expect("whatsapp can push", canPushAsync("whatsapp"));

// Non-push: render only to a live client.
expect("web cannot push", !canPushAsync("web"));
expect("cli cannot push", !canPushAsync("cli"));

// Unknown channels fail open (assumed push-capable; no spurious warnings on new channels).
expect("unknown channel assumed push-capable", canPushAsync("matrix"));

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
