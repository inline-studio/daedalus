// Smoke for the post-build cleanup `dae install` runs after a successful bring-up.
//
// Why this exists: every `up --build` strands the previous daedalus/graphiti build as
// a dangling <none> image plus buildkit cache. On casa that accumulated 208 images
// (12 active) + 34.6GB of cache, filled the 115GB disk, and broke sqlite writes. The
// cleanup prunes those — but it MUST stay surgically scoped: the label filter is the
// only thing keeping it away from other compose projects' images, and the whole
// mechanism silently stops working if docker-compose.yml's build labels drift from
// DAEDALUS_IMAGE_LABEL. No docker daemon needed here — pure wiring checks.
//
// Coverage:
//   1. The image prune is dangling-only (no -a/--all), forced, label-scoped to
//      DAEDALUS_IMAGE_LABEL, and never touches volumes.
//   2. The builder prune is forced, keeps a retention (--keep-storage <size>), and
//      doesn't pass --all.
//   3. Every `build:` section in docker-compose.yml stamps the label the prune
//      filters on — the invariant that makes (1) actually match anything.
//   4. reclaimedSpace parses docker's summary line and stays quiet on 0B/absent.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  dockerCleanupCommands,
  DAEDALUS_IMAGE_LABEL,
  BUILDER_CACHE_KEEP,
  reclaimedSpace,
} from "../dist/install.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

const { imageArgs, builderArgs } = dockerCleanupCommands();

// 1. Image prune: dangling-only, forced, label-scoped, no volumes.
ok("image prune targets images", imageArgs[0] === "image" && imageArgs[1] === "prune");
ok("image prune is forced (no interactive hang)", imageArgs.includes("-f") || imageArgs.includes("--force"));
ok(
  "image prune is dangling-only (no -a/--all — tagged images stay)",
  !imageArgs.includes("-a") && !imageArgs.includes("--all"),
);
ok(
  "image prune is scoped to the daedalus label",
  imageArgs.includes("--filter") && imageArgs.includes(`label=${DAEDALUS_IMAGE_LABEL}`),
);
ok(
  "cleanup never mentions volumes",
  ![...imageArgs, ...builderArgs].some((a) => a.includes("volume")),
);

// 2. Builder prune: forced, retention-capped, not --all.
ok("builder prune targets build cache", builderArgs[0] === "builder" && builderArgs[1] === "prune");
ok("builder prune is forced", builderArgs.includes("-f") || builderArgs.includes("--force"));
ok(
  "builder prune keeps a cache retention",
  builderArgs.includes("--keep-storage") &&
    builderArgs[builderArgs.indexOf("--keep-storage") + 1] === BUILDER_CACHE_KEEP,
);
ok("builder prune doesn't pass --all", !builderArgs.includes("-a") && !builderArgs.includes("--all"));
ok("retention is a sane size string", /^\d+(\.\d+)?[KMGT]?B$/i.test(BUILDER_CACHE_KEEP));

// 3. Every build section in the shipped compose file stamps the label the filter
//    matches. A new build section without it, or a rename on either side, would make
//    the prune silently collect nothing — this is the drift guard.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = YAML.parse(await fs.readFile(path.join(repoRoot, "docker-compose.yml"), "utf8"));
const [labelKey, labelValue] = DAEDALUS_IMAGE_LABEL.split("=");
const buildServices = Object.entries(compose.services ?? {}).filter(([, s]) => s && s.build);
ok("compose file has build sections to check", buildServices.length > 0, String(buildServices.length));
for (const [name, svc] of buildServices) {
  const labels = svc.build?.labels ?? {};
  ok(
    `service '${name}' build stamps ${DAEDALUS_IMAGE_LABEL}`,
    String(labels[labelKey]) === labelValue,
    JSON.stringify(labels),
  );
}

// 4. reclaimedSpace parser.
ok(
  "parses docker's reclaimed-space summary",
  reclaimedSpace("Deleted Images:\nuntagged: x\n\nTotal reclaimed space: 21.61GB\n") === "21.61GB",
);
ok("stays quiet on 0B", reclaimedSpace("Total reclaimed space: 0B") === null);
ok("stays quiet when the line is missing", reclaimedSpace("nothing to do") === null);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
