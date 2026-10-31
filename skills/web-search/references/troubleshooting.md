# Exa troubleshooting (REST)

Costs and statuses are from live calls plus https://exa.ai/docs/get-started/exa-mcp. Prefer the REST
API; see `mcp-alternative.md` if the MCP endpoint is genuinely wanted.

## Diagnose by status code

| Symptom | Cause | Fix |
|---|---|---|
| `401` / `403` | Bad or missing key | Send `x-api-key`. Verify at https://dashboard.exa.ai/api-keys. |
| `402` / quota error | Plan exhausted | Nothing to fix in code. Tell the user; do not loop. |
| `429` | Rate limited | Back off once, then report. Never retry in a tight loop. |
| `200` but `results: []` | Query too narrow, or filters exclude everything | Describe the ideal page instead of keywords; drop `includeDomains` / date filters; raise `numResults`. |
| `200` with `warnings` | Parameter had no effect | Read the warning, remove the field (`IGNORED_FIELD` means deprecated/unsupported). |
| Contents returns empty `text` | JS-rendered or blocked page | Try `livecrawl`, or use another source. Plain HTTP fetch, no headless browser. |
| Text truncated mid-sentence | `maxCharacters` too low | Re-fetch just that URL with a larger `maxCharacters`. |
| Validation error mentioning a param | `type: "lite"` rejects it | Switch to `type: "auto"`, or drop the filter. |

Check `statuses[]` in a contents response: individual URLs can fail while the call itself returns
`200`.

## Environment gotchas (this machine)

- Shell command substitution `$(...)` and heredocs are blocked by the tool guard. Write the JSON
  payload inline in `-d '...'` and send output to a file with `-o`.
- Inline `node -e` / `python3 -c` are blocked. Use `grep`/`read` on the saved file, or `codemode`.
- Always use `-o /tmp/exa.json` (or check `%{http_code}`). Printing raw JSON floods context.

## MCP-specific failure modes (only if you use the MCP endpoint)

- **Tool missing / hangs** — the hosted server reports an exhausted free plan as a hang or timeout
  rather than a clean error. Requires the `x-api-key` header, or a paid plan.
- **New server not visible in a running session** — `codemode` MCP servers connect at session start;
  adding one to `~/.pi/agent/mcp.json` needs `/reload` or a restart. This is the main reason the REST
  path is preferred here.

## Staleness

If this contradicts https://exa.ai/docs or https://docs.exa.ai, the docs win — fix this file.
