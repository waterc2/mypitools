---
name: web-search
description: Search the web when an answer needs current or uncertain external information.
---

# Web Search (Exa REST)

No MCP, no client config, no restart. Call Exa's HTTP API with `curl`. Output goes to a file so raw
JSON never floods context.

The key is read from the `EXA_API_KEY` environment variable, so it never lives in this file. If it is
unset, stop and ask the user to export it (create one at https://dashboard.exa.ai/api-keys) rather
than pasting a literal key anywhere.

## Search

```bash
curl -s -o /tmp/exa.json -X POST https://api.exa.ai/search \
  -H "x-api-key: $EXA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"...","numResults":5,"contents":{"highlights":{"maxCharacters":500}}}'
```

Then read only what is needed — never dump the file:

```bash
grep -o '"url":"[^"]*"' /tmp/exa.json
```

Read `/tmp/exa.json` directly if the whole result is small.

## Read specific pages

```bash
curl -s -o /tmp/exa.json -X POST https://api.exa.ai/contents \
  -H "x-api-key: $EXA_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://a.example","https://b.example"],"text":{"maxCharacters":4000}}'
```

## Rules

- Query with a **description of the ideal page**, not keywords: `"blog post comparing React and Vue performance"`.
- Prefer `highlights` (short excerpts) over full `text`; raise `maxCharacters` only when an excerpt was cut.
- Batch URLs into one `urls` array rather than looping.
- Skip the web for local-only questions; do not search speculatively.
- Never hardcode or echo the key; reference `$EXA_API_KEY` only.
- On 429 / timeout / unexpected shape, read `references/troubleshooting.md` once. Do not retry identically.
- Avoid shell command substitution and inline `node -e`/`python3 -c` in this environment; write output to files and use `grep`/`read`.

## Load on demand

| Need | Read |
|---|---|
| All parameters, filter/date/category options, `lite` vs `auto`, response fields | `references/api.md` |
| 401 / 402 / 429 / empty results / truncated text | `references/troubleshooting.md` |
| The MCP variant (`https://mcp.exa.ai/mcp`) and why it is not used here | `references/mcp-alternative.md` |

Do not read these unless a call actually needs them.
