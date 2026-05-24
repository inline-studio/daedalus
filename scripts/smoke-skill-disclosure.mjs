// Smoke for progressive skill disclosure: the system prompt carries only a skill
// MENU (name + one-line description), NOT the full SKILL.md bodies; the `load_skill`
// tool fetches a full body on demand and errors clearly on an unknown name.

import { composeSystemPrompt } from "../dist/brain/composer.js";
import { buildLoadSkillTool } from "../dist/tools/load-skill.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const mkSkill = (name, description, body) => ({
  manifest: { name, description, version: "0.0.0", toolsRequired: [], requires: { secrets: [] } },
  body,
  rootPath: `/brain/skills/${name}`,
  readOnly: true,
});

const BROWSER_BODY = "STEP ONE: run agent-browser open. STEP TWO: snapshot. SECRET_MARKER_XYZ.";
const skills = [
  mkSkill("agent-browser", "Drive a headless Chromium browser", BROWSER_BODY),
  mkSkill("qmd", "Render quick markdown", "QMD_BODY_MARKER render to pdf"),
];

const baseInput = {
  brainPath: "/nonexistent-brain", // standards/operations/souls dirs absent → those sections empty
  agent: {
    name: "tester",
    standards: [],
    operations: [],
    souls: [],
    personas: [],
    timeAware: false,
  },
  agentBody: "",
  skills,
};

// 1. Composer lists names + descriptions but NOT the bodies.
{
  const prompt = await composeSystemPrompt(baseInput);
  expect("menu lists skill names", prompt.includes("agent-browser") && prompt.includes("qmd"));
  expect(
    "menu includes one-line descriptions",
    prompt.includes("Drive a headless Chromium browser") && prompt.includes("Render quick markdown"),
  );
  expect(
    "full bodies are NOT inlined",
    !prompt.includes("SECRET_MARKER_XYZ") && !prompt.includes("QMD_BODY_MARKER"),
  );
  expect("menu mentions load_skill", /load_skill/.test(prompt));
}

// 2. load_skill returns the full body for a known skill.
{
  const tool = buildLoadSkillTool(skills);
  const res = await tool.invoke({ name: "agent-browser" }, {});
  expect(
    "load_skill returns the full body",
    !res.isError && res.content.includes("SECRET_MARKER_XYZ"),
    res.content.slice(0, 60),
  );
  // The tool advertises the available names so the model can self-correct.
  const enumNames = tool.definition.inputSchema.properties.name.enum;
  expect(
    "input schema enum lists skills",
    Array.isArray(enumNames) && enumNames.includes("agent-browser") && enumNames.includes("qmd"),
    JSON.stringify(enumNames),
  );
}

// 3. Unknown skill → clear, non-throwing error that lists what's available.
{
  const tool = buildLoadSkillTool(skills);
  const res = await tool.invoke({ name: "nope" }, {});
  expect(
    "unknown skill → actionable error",
    res.isError === true && /unknown skill/i.test(res.content) && res.content.includes("agent-browser"),
    res.content.slice(0, 80),
  );
}

// 4. No skills → no Skills section at all (nothing to disclose).
{
  const prompt = await composeSystemPrompt({ ...baseInput, skills: [] });
  expect("no skills → no Skills section", !/# Skills/.test(prompt));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
