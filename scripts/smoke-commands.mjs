// Smoke for the commands subsystem.
//
// Builds a fake brain with one command, runs the loader / detector / resolver
// directly, then exercises the ingest-side slash expansion to confirm the
// preamble shape lands correctly in the persisted user message.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCommand,
  listCommandNames,
  loadAgentCommands,
  detectSlashCommand,
  resolveCommand,
} from "../dist/brain/commands.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const brainRoot = mkdtempSync(join(tmpdir(), "dae-commands-brain-"));
mkdirSync(join(brainRoot, "commands"), { recursive: true });

writeFileSync(
  join(brainRoot, "commands", "ship.md"),
  `---
description: stage, commit, push
aliases: [s, send]
---

Run \`git status\`, then stage and commit everything, then push.
`,
);

writeFileSync(
  join(brainRoot, "commands", "standup.md"),
  `Write a short standup summary.\n`,
);

// 1. listCommandNames returns the bare filenames.
{
  const names = await listCommandNames(brainRoot);
  expect(
    "listCommandNames returns both commands",
    JSON.stringify([...names].sort()) === JSON.stringify(["ship", "standup"]),
    `got ${names.join(",")}`,
  );
}

// 2. loadCommand reads frontmatter + body.
{
  const cmd = await loadCommand(brainRoot, "ship");
  expect("loadCommand returns the body", cmd?.body.includes("git status"));
  expect("loadCommand parses aliases", JSON.stringify(cmd?.manifest.aliases) === '["s","send"]');
  expect("loadCommand parses description", cmd?.manifest.description === "stage, commit, push");
}

// 3. loadAgentCommands honours the wildcard and the subset selector.
{
  const all = await loadAgentCommands(brainRoot, ["*"]);
  expect("['*'] loads every command", all.length === 2);
  const subset = await loadAgentCommands(brainRoot, ["ship"]);
  expect("['ship'] loads only that one", subset.length === 1 && subset[0].manifest.name === "ship");
  const none = await loadAgentCommands(brainRoot, []);
  expect("[] loads nothing (subagent default)", none.length === 0);
  const unknown = await loadAgentCommands(brainRoot, ["nope"]);
  expect("unknown names are silently skipped", unknown.length === 0);
}

// 4. detectSlashCommand parses the leading token + rest.
{
  expect("/ship at the start → name=ship, rest=''", JSON.stringify(detectSlashCommand("/ship")) === '{"name":"ship","rest":""}');
  expect(
    "/ship with args → name=ship, rest='arg1 arg2'",
    JSON.stringify(detectSlashCommand("/ship arg1 arg2")) === '{"name":"ship","rest":"arg1 arg2"}',
  );
  expect("no slash → null", detectSlashCommand("hello there") === null);
  expect("slash mid-line is NOT a command", detectSlashCommand("see /docs/api") === null);
  expect("leading whitespace before slash still matches", detectSlashCommand("   /ship now") !== null);
  expect("multi-line args preserved", detectSlashCommand("/ship now\nand then\nfinally")?.rest === "now\nand then\nfinally");
}

// 5. resolveCommand finds by name and by alias, case-insensitive.
{
  const all = await loadAgentCommands(brainRoot, ["*"]);
  expect("resolveCommand by name", resolveCommand(all, "ship")?.manifest.name === "ship");
  expect("resolveCommand by name (case-insensitive)", resolveCommand(all, "SHIP")?.manifest.name === "ship");
  expect("resolveCommand by alias", resolveCommand(all, "s")?.manifest.name === "ship");
  expect("resolveCommand by alias 'send'", resolveCommand(all, "send")?.manifest.name === "ship");
  expect("unknown command resolves to null", resolveCommand(all, "nope") === null);
}

rmSync(brainRoot, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
