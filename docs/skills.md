# Skills

A **skill** packages a capability: instructions for the model (so it knows *how* to use
something) plus an optional install script (so the *binary* it needs is on `PATH`).
Skills live in `brain/skills/<name>/` and are pulled into an agent via its `skills:` list
(`['*']` = all).

```
brain/skills/
  agent-browser/
    SKILL.md          frontmatter + instructions (required)
    bootstrap.sh      install script (optional)
```

## SKILL.md

Frontmatter + a markdown body. The body is injected into the agent's system prompt under
a **Skills** section (`### <name>\n<body>`), so write it as instructions to the model.

```markdown
---
name: brave-search            # taken from the directory name; informational here
description: "Web search via the Brave API."
version: 1.0.0
toolsRequired: [web_search]   # built-in tools this skill needs at runtime
requires:
  secrets: [BRAVE_API_KEY]    # secrets that must resolve when the skill loads
---

Use `web_search` for fresh information. Prefer Brave results; cite the URL.
```

| Field | Type / default | What it does |
|---|---|---|
| `name` | string | Skill id (from the directory name). |
| `description` | string, `""` | Short summary. |
| `version` | string, `0.0.0` | Informational. |
| `toolsRequired` | string[], `[]` | Built-in tools the skill needs. Daedalus checks each is in the agent's `tools:` list before the turn runs, so a missing dependency fails fast instead of mid-task. |
| `requires.secrets` | string[], `[]` | Secret names that must resolve (env or the secrets backend) when the skill loads. Missing ones surface a clear warning at agent start. |

## bootstrap.sh — the install script

If a skill ships a `bootstrap.sh` next to `SKILL.md`, daedalus runs it **once per
(skill, content-hash)** before the agent turn. The script's job: put the skill's binaries
on `PATH` without modifying the base image.

How it runs:

- **Idempotent + cached.** The hash is over the script bytes; a success marker lands in
  `skill-bin/.bootstrap/<skill>-<hash>.ok`. It re-runs only if you edit the script.
- **Non-fatal.** A failure is logged (visible in `docker compose logs`) but doesn't abort
  the turn — the skill loads anyway; the SKILL.md should describe a fallback.
- **5-minute cap**, generous for an `npm install` / binary download.
- **Environment provided:**
  - `DAE_SKILL_BIN` — a per-skill scratch dir (put npm prefixes, venvs, downloads here).
  - `DAE_SKILL_PATH_DIR` — the shared bin dir that's prepended to the agent's `bash`
    `PATH`. Symlink your entrypoint here so it's discoverable.
  - `PATH` already includes `DAE_SKILL_PATH_DIR`.

These dirs live under `/data/skill-bin` (a persistent, cross-agent volume), so a tool
installed once is reused across turns and agents.

### The one hard rule: no root, no `apt`

Skill bootstraps run **without root you can rely on** (the warm worker runs as your host
UID). So a bootstrap can only do **user-space** installs:

- ✅ `npm install` into a prefix, `pip install --user`/venv, downloading a static binary
  to `$DAE_SKILL_BIN`.
- ❌ `apt-get install …` — needs root; it fails in the worker, and even where a container
  happens to be root the change is ephemeral (lost when the per-command container exits).

**System dependencies (shared libraries, language interpreters) belong in the image, not
the bootstrap.** See "The daedalus image" below.

### Example

```sh
#!/bin/sh
set -e
command -v mytool >/dev/null 2>&1 && exit 0          # fast path: already on PATH

# node + npm must exist in the image where this runs (they do, in the daedalus image)
PREFIX="$DAE_SKILL_BIN/npm-prefix"
mkdir -p "$PREFIX"
NPM_CONFIG_PREFIX="$PREFIX" npm install -g --no-audit --no-fund mytool >&2
ln -sf "$PREFIX/bin/mytool" "$DAE_SKILL_PATH_DIR/mytool"   # onto PATH
```

## The daedalus image (the warm runtime)

The daedalus image is what the **supervisor** and the **warm agent worker** run, and it's
where a no-`container.image` agent's `bash` (and its skill bootstraps) execute. So it
carries more than the bare runner:

- **Node** — runs daedalus itself and Node-based skill CLIs (e.g. `agent-browser`).
- **Docker CLI** (client only) — the supervisor/worker spawn agent containers over the
  mounted socket.
- **Chromium runtime libraries** — the X / font / nss / audio / GL libs Chromium needs,
  installed via Playwright's `install-deps`. These can't be added at runtime (non-root),
  so they're baked in. This is what lets `agent-browser` actually *launch*.
- **Common foundation** — `wget`, `xz-utils`, `bzip2`, `git`, `curl`, `jq`, `procps`,
  `iproute2`, `less`, and a `C.UTF-8` locale, so skill installers and shell work behave.

Per-language toolchains (Python, PHP, multiple Node versions) deliberately stay out of
this image — they belong in per-agent images referenced by `container.image`.

## agent-browser (the worked example)

`agent-browser` is a Node CLI that drives a real Chromium via Playwright (`open`,
`snapshot`, `click`, `fill`, `screenshot`, …). Two halves make it work:

1. **The image** provides Node + Chromium's system libs (above). Baked, because non-root
   can't install them.
2. **The bootstrap** `npm install`s the `agent-browser` CLI into `$DAE_SKILL_BIN` and
   downloads the Chromium binary at runtime (this part *is* user-space, so a skill does
   it).

Because `agent-browser` keeps a browser process alive across commands (`open` then
`snapshot`), the agent using it must run **warm** — i.e. **omit `container.image`** so its
`bash` runs in the persistent worker. A per-command `container.image` would kill the
browser between calls. (See [agents.md](./agents.md) → `container:`.)

To return the screenshot to the user, the agent calls the built-in `attach_to_reply`
tool — see [channels.md](./channels.md).
