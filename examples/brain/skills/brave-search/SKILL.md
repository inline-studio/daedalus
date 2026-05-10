---
description: Web search via the Brave Search API. More reliable than DuckDuckGo's HTML scrape; needs an API key.
version: 0.1.0
toolsRequired: [web_search, web_fetch]
requires:
  secrets: [BRAVE_API_KEY]
---

# Brave Search

When the user asks a research question or needs up-to-date information, use the
`web_search` tool followed by `web_fetch` on the most relevant result.

This skill assumes the runner is configured with `web.search.provider: brave`. If you
get an error like *"web_search has no provider configured"*, the user needs to run:

    dae setup search

…and pick `brave`. The API key gets stored via the configured secrets backend
(OneCLI when reachable, otherwise `.env.local`). Free tier is 2,000 queries/month.

## Workflow guidelines

1. Search first with a targeted query — fewer, more specific terms beat long sentences.
2. Read the snippets; pick at most 2–3 URLs that look most authoritative.
3. `web_fetch` each in turn; the tool returns markdown with chrome stripped.
4. Cite specific URLs in your answer; quote sparingly.
5. If a result requires JavaScript rendering (a SPA, a Cloudflare-walled page), say so —
   don't pretend you read it. Mounting a `playwright-mcp` server in the brain would solve
   that case; it's not yet wired by default.

## When NOT to search

- The user is referencing files in the repo or `BRAIN_PATH` — use `read` instead.
- The answer is in your training data and unlikely to have changed (e.g., basic syntax).
  Search wastes a turn.
