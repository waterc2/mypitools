# Exa REST API reference

Verified against https://docs.exa.ai/reference/search and https://docs.exa.ai/reference/get-contents
and by live calls on 2026-10-31. Auth header: `x-api-key: <key>`.

## POST https://api.exa.ai/search

| Param | Type | Notes |
|---|---|---|
| `query` | string, required | Natural-language description of the ideal page. |
| `numResults` | number | Default 10. |
| `type` | enum | `auto` (default, recommended, supports all params); `lite` (cheap/fast, cached index, **only** the params listed below); `deep`/`deep-lite` (multi-step research); `instant`/`fast` are **legacy — use `lite`**. |
| `category` | string | e.g. `company`, `people`, `news`, `research paper`, `github`, `tweet`. |
| `includeDomains` / `excludeDomains` | string[] | Hostname, path prefix (`example.com/docs`), or `*.example.com`. Max 1200 entries. |
| `startPublishedDate` / `endPublishedDate` | string (ISO 8601) | Publication-date window. |
| `startCrawlDate` / `endCrawlDate` | — | **Deprecated**, ignored. |
| `userLocation` | string | Country code, e.g. `US`. |
| `contents` | object | See below. |
| `objective` | string | Goal for the search turn. |
| `systemPrompt` | string | Source/novelty/duplication guidance. |
| `outputSchema` | object | Enables synthesized `output`; required for `stream`. |
| `stream` | boolean | SSE streaming; only with `outputSchema`. |

### contents object

```json
"contents": { "text": {"maxCharacters": 3000}, "highlights": {"maxCharacters": 500}, "summary": {"query": "..."} }
```

- `text: true` or `{maxCharacters}` — full page text.
- `highlights` — short query-relevant excerpts. **Cheapest useful default.**
- `summary` — LLM summary; `{query}` focuses it.
- `extras` — links, image links.
- When highlights or summaries are requested, plain page text is omitted unless `text` is set too.

### `type: "lite"` allowed params

`query`, `objective`, `userIdentifier`, `metadata`, `category`, `numResults`, `contents.highlights`,
`contents.text`, `contents.snapshotAsOf`, `userLocation`, `includeDomains`, `excludeDomains`,
`startPublishedDate`, `endPublishedDate`, `moderation`, `compliance`. Any other param is rejected.
Lite serves from Exa's refreshed index; freshness options that need live fetching are unsupported.

### Response

```json
{ "requestId": "...", "results": [ {"id","title","url","publishedDate","author","highlights":[],"text","score"} ],
  "output": {}, "costDollars": {}, "searchTime": 123, "warnings": [], "notices": [] }
```

`warnings` (e.g. `IGNORED_FIELD`) are for logs, not the model. `notices` describe how results were
produced and should be passed along with them. `context` is **deprecated** — use
`results[].highlights` / `results[].text`.

## POST https://api.exa.ai/contents

| Param | Type | Notes |
|---|---|---|
| `ids` **or** `urls` | string[] | Provide **one**, not both. 1–100 elements. `urls` is backwards compatible with `ids`. |
| `text` | boolean or `{maxCharacters,...}` | Page text. |
| `highlights` | object | Relevant excerpts. |
| `summary` | object | LLM summary. |
| `extras`, `livecrawl`, `subpages`, `context` | — | Additional content options. |
| `compliance` | enum | `hipaa`, enterprise only. |

Response: `{ requestId, results: [...], statuses: [{id, status, error?}], costDollars, searchTime }`.
Check `statuses[]` — a URL can fail (e.g. 404, blocked) while others succeed.

## Extracting from saved JSON

Avoid shell command substitution and inline interpreters here. Instead:

```bash
grep -o '"url":"[^"]*"' /tmp/exa.json          # result URLs
grep -o '"highlights":\[[^]]*\]' /tmp/exa.json # excerpts
```

For anything more complex, read `/tmp/exa.json` directly.

## Billing note

Each call returns `costDollars`. `highlights` with a small `maxCharacters` is the cheapest useful
shape; full `text` on many results is the most expensive. Prefer few results with excerpts, then
follow up on the one URL that matters.
