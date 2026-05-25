// Guard that the compose passes a stable SECRET_ENCRYPTION_KEY into OneCLI. Without it, OneCLI
// auto-generates its secret-encryption key into the EPHEMERAL /app/data, so a container recreate
// or image update silently rotates the key and makes every stored secret undecryptable — the
// casa outage where every agent turn failed with "decryption failed: invalid key". `dae install`
// pins the key in .env; this asserts the onecli service actually reads it from there.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");

let pass = true;
const ok = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) pass = false;
};

ok(
  "docker-compose.yml passes SECRET_ENCRYPTION_KEY into the onecli service",
  /SECRET_ENCRYPTION_KEY:\s*\$\{SECRET_ENCRYPTION_KEY/.test(compose),
);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
