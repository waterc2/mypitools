# MCP alternative (not used by default)

Decision: this skill calls the **REST API** (`api.exa.ai/search`, `api.exa.ai/contents`). MCP is
optional and only worth it if the model should treat Exa as discoverable tools rather than shell
calls.

Why REST won here:

- No client config, no `/reload`, no restart — works in the current session immediately.
- One `curl` per call; nothing new appears in the tool list or system prompt.
- Full `contents` parameters (filters, `lite`/`auto`, extras) without a second schema layer.
- Easy to keep raw JSON out of context via `-o file`.

MCP trade-offs: schema-aware tool calls, but a hosted-server layer, plan-limit hangs, and a restart
before a newly added server is visible to `codemode`.

## If you do want MCP

Endpoint: `https://mcp.exa.ai/mcp` (server `exa-search-server`). Add to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "exa": {
      "url": "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,agent_run,web_search_advanced_exa",
      "headers": { "x-api-key": "<key>" },
      "exposure": "codemode"
    }
  }
}
```

- Without `?tools=`, only `web_search_exa` and `web_fetch_exa` are exposed; `web_search_advanced_exa`
  and `agent_run` must be listed explicitly (verified: the `?tools=` filter works).
- With `exposure: "codemode"`, call from codemode after `searchTools("exa")`; the tools are **not** in
  `ALL_TOOLS` and `describeNamespace("exa")` returns nothing until a session picks up the config.
- `deferred` instead makes them loadable via `tool_search`; `direct` puts them in the tool list
  permanently (costly for a rarely used tool).
- Verify with `pi mcp list` — it connects out of process and lists the 4 tools even when a running
  session has not loaded them yet.

MCP tools roughly map to REST as: `web_search_exa` → `/search` with highlights; `web_fetch_exa` →
`/contents` with `urls` + `maxCharacters`; `web_search_advanced_exa` → `/search` with category/domain/
date filters; `agent_run` → Exa Agent (auth required).
