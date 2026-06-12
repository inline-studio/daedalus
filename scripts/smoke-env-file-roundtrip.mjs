// SEC-14: a newline in a secret value must not split the dotenv file and inject a spurious
// KEY= entry. quoteValue escapes \n/\r; the backend's unquote decodes them (single-pass, so
// an escaped backslash isn't confused with an escape sequence). Values round-trip exactly.

import { EnvFileSecretsBackend } from "../dist/secrets/store/env-file-backend.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sec14-"));
const f = path.join(dir, ".env.local");
const be = new EnvFileSecretsBackend(f);

// 1. A newline-bearing value crafted to look like an injected entry.
const injectionVal = "legit-start\nINJECTED_KEY=evil\nlegit-end";
await be.save("SAFE_KEY", injectionVal);
await be.save("OTHER_KEY", "plain");

expect("newline value round-trips through save/get", (await be.get("SAFE_KEY")) === injectionVal);

const fileText = await fs.readFile(f, "utf8");
const lines = fileText.split(/\r?\n/);
expect("no injected INJECTED_KEY= line in the file", !lines.some((l) => l.startsWith("INJECTED_KEY=")));
expect("SAFE_KEY stored on exactly one physical line", lines.filter((l) => l.startsWith("SAFE_KEY=")).length === 1);
expect("OTHER_KEY unaffected", (await be.get("OTHER_KEY")) === "plain");

// 2. Quotes + backslashes (incl. a LITERAL backslash-n, which must NOT become a newline).
const tricky = 'a"b\\c\\nd'; // = a " b \ c \ n d
await be.save("TRICKY", tricky);
expect("quotes/backslashes round-trip (literal \\n preserved)", (await be.get("TRICKY")) === tricky, JSON.stringify(await be.get("TRICKY")));

// 3. Carriage return round-trips.
await be.save("CR_KEY", "x\ry");
expect("carriage return round-trips", (await be.get("CR_KEY")) === "x\ry");

await fs.rm(dir, { recursive: true, force: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
