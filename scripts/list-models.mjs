// List models from the configured OpenAI-compatible endpoint.
// Loads OPENAI_API_KEY from .env.local; only prints model IDs to stdout.
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });

import yaml from "yaml";
import fs from "node:fs";

const cfg = yaml.parse(fs.readFileSync("examples/daedalus.config.yaml", "utf8"));
const baseUrl = cfg.providers?.openai?.baseUrl ?? "";
const key = process.env.OPENAI_API_KEY;

if (!key) {
  console.error("OPENAI_API_KEY not set in .env.local");
  process.exit(2);
}
if (!baseUrl) {
  console.error("providers.openai.baseUrl not set in config");
  process.exit(2);
}

const url = `${baseUrl.replace(/\/$/, "")}/models`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });

if (!res.ok) {
  const body = await res.text().catch(() => "");
  console.error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  process.exit(1);
}

const json = await res.json();
const ids = (json.data ?? []).map((m) => m.id).sort();
console.log(`baseUrl: ${baseUrl}`);
console.log(`models (${ids.length}):`);
for (const id of ids) console.log(`  ${id}`);
