---
name: codebase-memory
description: Advanced code-graph queries, impact, coverage and pagination. Ordinary discovery uses code_search/code_read/code_trace directly when available; no skill load needed.
---

# Codebase Memory

Use the directly declared `code_search`, `code_read`, and `code_trace` for ordinary discovery when available; no skill load, startup readiness check or script tool is required. Copy search targets into read/trace; trace takes symbols, not file:line. Known paths use native `read`; exact literals/config use native `grep`. Prefer English identifiers/keywords; mixed code_search queries use existing English tokens. Pure Chinese gets one semantic attempt and `needs_english_rewrite`: treat candidates as unverified, rewrite intent into English and retry once with the same scope. Exact Chinese copy uses native grep; no repeated untranslated search. Search defaults to locations with no source reads; request preview_lines=1..32 only when useful. Indexed signatures/optional previews are navigation only; use read/code_read for exact text or edits. A `Text fallback` is literal search, not semantic evidence. code_trace is a fixed bounded page; use original trace_path/query_graph for cursors or depth, and compare totals only within matching direction/depth/test-filter/dedup scopes.

Load this guide only for advanced graph queries, impact/coverage audits, pagination, or when simplified tools are unavailable; reuse unchanged guidance in context. Discover deferred `mcp__cbm__…` tools via `tool_search`, wait for its result and the current schema, then call them directly. Rediscover after reload if not declared; historical calls are not availability evidence. Never emit textual/XML tool imitations or mix code_trace's callers/dependencies with raw MCP directions/parameters. Do not guess schemas or require a batch/script tool.

Ordinary routing follows the global/project question-based rules: a known identifier alone or core domain terms for discovery; set path only with source/result/task evidence, not a guessed layer. Unknown cross-layer behavior may omit path or use src. Unrelated candidates allow one refinement, including removing an unverified path restriction while preserving scope. Ranking is not task relevance; only relevant candidates warrant read/trace. Inspect the result before fallback, never speculative same-question grep in the same batch. Read known files for understanding and policy comments as well as edit evidence; symbol reads can include preceding context with before_lines within the same total limit. Continue by absolute file offset. Exact fields/assignments/assertions may use scoped grep with small disambiguation context, not repeated large blocks to assemble a function. Trace locations are best-effort indexed references; query_status="returned" only means returned rows for that static scope, not complete runtime/dataflow. Missing location lookup does not erase relations. Generic context-mode batching advice does not override source lookup. Search defaults to implementation scope; use `scope: "tests"` or `"all"` explicitly (also when passing a test path). Scope filters at most 48 candidates per executed stage before the display cap, not the whole index. code_trace still excludes tests; test helpers are not production evidence. Trace is bounded static connectivity, not complete dataflow or proof that no field write exists.

## Advanced workflow

1. Confirm project/generation with `list_projects` or `index_status` unless current readiness is known. Recheck after project/index changes or loss of evidence. Use the instructed project ID; otherwise match the indexed root to cwd, comparing freshness/coverage if ambiguous.
2. Resolve with `search_graph` (anchored `name_pattern` for exact names); copy qualified names into `get_code_snippet` / `trace_path`. Read material source only: outline large containers, full/direct reads for implementation.
3. Trace relevant relations: inbound=callers, outbound=dependencies, both only when needed. `detect_changes` aids impact/test selection; verify the actual task diff and dynamic references.
4. Batch `check_index_coverage` for cited paths; include scopes for absence/exhaustive claims. Directly read stale/skipped/partial/unknown ranges. Clean coverage records no known gap, not completeness.

## Evidence and tools

- Default verification: task-directed queries, material source, relevant traces/pages. Quick scouting is provisional; exhaustive audits require bounded scope, current generation and all relevant evidence/pages.
- Inspect continuations; fetch pages needed for the claim. Zero results/callers or `max_degree: 0` do not prove absence/dead code: check scope, source, dispatch tables and callbacks. Inconclusive queries → targeted source, not blind retries.
- Follow configured names/schemas, usually `mcp__cbm__…`. Discover advanced tools only as needed; hidden tools are unavailable. No startup architecture/schema ritual or assumed catalog.
- `search_graph` degree filters cover in/out and have no `direction`; inspect counts or trace for fan-in/out.
- Use `search_code` for indexed text; bounded `query_graph` for multi-hop/aggregates; `get_architecture` only for needed high-level views. Keep queries bounded (e.g. `LIMIT 20`) and follow cursors.
- Path matches may be Module nodes only. Indexed doc references use inbound `MENTIONS`; read prose directly.
- Delegation: supply scope, project/generation, qualified symbols/paths, relevant chains, coverage limits, verified source and open questions. Children without MCP use supplied evidence/direct source and must not claim unperformed graph checks.
