// Smoke test for web_fetch and web_search tools.
// Bypasses the LLM. Drives the tool implementations directly.

import { loadConfig } from "../dist/config/load.js";
import { webFetchTool, webSearchTool } from "../dist/tools/web.js";

const config = loadConfig("examples/daedalus.config.yaml");
console.log(`web.search.provider: ${config.web.search.provider}`);
console.log(`web.fetch.maxBytes: ${config.web.fetch.maxBytes}`);
console.log("---");

const fetchT = webFetchTool(config.web);
const searchT = webSearchTool(config.web);

const ctx = {
  runtime: { id: "host", exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }) },
  brainPath: config.brain.path,
  brainWritable: config.brain.writable,
  workspacePath: process.cwd(),
  agentName: "smoke",
};

// 1. web_fetch on a static page
console.log("[1] web_fetch https://example.com");
const r1 = await fetchT.invoke({ url: "https://example.com" }, ctx);
const ok1 = !r1.isError && r1.content.includes("Example Domain");
console.log(`    pass: ${ok1}`);
console.log(r1.content.slice(0, 400).split("\n").map((l) => "    " + l).join("\n"));
console.log("");

// 2. web_fetch raw=true on a JSON endpoint
console.log("[2] web_fetch raw https://httpbin.org/json");
const r2 = await fetchT.invoke({ url: "https://httpbin.org/json", raw: true }, ctx);
const ok2 = !r2.isError && r2.content.includes("slideshow");
console.log(`    pass: ${ok2}`);
console.log(r2.content.split("\n").slice(0, 8).map((l) => "    " + l).join("\n"));
console.log("");

// 3. web_search via configured provider
console.log(`[3] web_search "site:nodejs.org LTS schedule" via ${config.web.search.provider}`);
const r3 = await searchT.invoke({ query: "site:nodejs.org LTS schedule", limit: 3 }, ctx);
const ok3 = !r3.isError && /https?:\/\//.test(r3.content);
console.log(`    pass: ${ok3}`);
console.log(r3.content.split("\n").map((l) => "    " + l).join("\n"));

const allPass = ok1 && ok2 && ok3;
console.log(`\nresult: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
