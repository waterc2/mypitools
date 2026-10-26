// PURPOSE: make codebase-memory index freshness visible to the model at the exact
// moment it matters. Measured on this machine (2026-10-06, cbm 0.11.0 daemon +
// watcher): a file edit is committed into a new index generation in ~4-15s
// (single-file append found by search_code at +4s; new file found by search_graph
// at +18s; generation stamp advanced 13-23s after a 40-file burst). The graph is
// NOT hour-stale — but a file the agent edited a few seconds ago is inside that
// watcher window, and its snippet/line ranges can predate the edit. This extension
// names that window instead of letting the model guess (guessing is what sends it
// back to `grep -rn` over src/).
// INPUT: `tool_result` events (pi emits `tool_call` / `tool_result`; there is no
// before/after_tool_call). Records paths from successful `edit` / `write` results,
// inspects cbm tool results for those paths.
// MUTATION: two annotations, both one line, both only inside the risk window:
// (a) a cbm result that cites a path this session edited -> prepended warning that
// its line ranges may predate the edit; (b) a cbm 0-result within the window after
// a write -> appended warning that the miss is index lag, not absence. Everything
// else passes through untouched; structuredContent is not rewritten (nothing is
// redacted, so keeping it is correct per docs/extensions.md).
// DETERMINISM: pure wall-clock recency comparison; no randomness, no shell, no
// extra cbm calls, no blocking. Handler errors are caught and the call passes.

const EDIT_TOOLS = new Set(['edit', 'write']);

// MCP tool names arrive as `mcp__cbm__get_code_snippet`; match on the tail so the
// extension keeps working if the server is renamed or the exposure changes.
const CBM_TOOLS = new Set([
  'get_code_snippet',
  'search_code',
  'search_graph',
  'trace_path',
  'get_architecture',
  'get_file_outline',
  'check_index_coverage',
  'detect_changes',
  'index_status',
]);

// Measured watcher commit latency is 4-15s. 60s is deliberately wider than the
// measured window: the warning is one line, and a false "just edited" note is
// cheaper than a stale line range used as ground truth.
const EDIT_RISK_WINDOW_MS = 60_000;
const MAX_TRACKED_EDITS = 300;

// cbm's "nothing found" shapes, tree and json alike. A 0-result is not an error,
// but right after a write it is usually index lag rather than absence.
const EMPTY_RESULT_RE =
  /(?:total_results|total_grep_matches|files|results|matches|rows|nodes)\s*[:=]\s*0\b|"(?:total_results|total_grep_matches|files|results|rows)"\s*:\s*0\b|\bno matches\b|\bno results\b|\bnot found\b|\bempty\b/i;

type EditRecord = { path: string; at: number };

function isCbmTool(toolName: unknown): boolean {
  if (typeof toolName !== 'string') return false;
  const tail = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return CBM_TOOLS.has(tail);
}

function textBlocks(content: any): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text);
}

/** Repo-relative form of a path the edit tools were given. */
function normalizePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  let p = raw.trim().replace(/\\/g, '/');
  const cwd = (process.cwd() || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (cwd && p.startsWith(cwd + '/')) p = p.slice(cwd.length + 1);
  p = p.replace(/^\.\//, '');
  if (p.startsWith('/') || p.startsWith('..')) return undefined; // outside the repo: cbm cannot index it
  return p;
}

export default function (pi: any) {
  const edits = new Map<string, number>(); // repo-relative path -> last edit epoch ms

  // Opt-in proof that the handler fired in a live session (silent unless
  // CBM_FRESH_DEBUG names a log file).
  const debugLog = async (toolName: string, detail: string) => {
    const target = process.env.CBM_FRESH_DEBUG;
    if (!target) return;
    try {
      const fs = await import('node:fs');
      fs.appendFileSync(target, `${new Date().toISOString()} ${toolName} ${detail}\n`);
    } catch {
      /* debug only */
    }
  };

  pi.on('tool_result', async (event: any) => {
    try {
      const toolName: string = event?.toolName ?? '';

      if (EDIT_TOOLS.has(toolName)) {
        if (event?.isError === true) return;
        const path = normalizePath(event?.input?.path);
        if (!path) return;
        edits.set(path, Date.now());
        if (edits.size > MAX_TRACKED_EDITS) {
          const oldest = edits.keys().next().value;
          if (oldest !== undefined) edits.delete(oldest);
        }
        return;
      }

      if (!isCbmTool(toolName)) return;

      const texts = textBlocks(event?.content);
      if (texts.length === 0) return;
      const text = texts.join('\n');

      const now = Date.now();
      const hits: Array<{ path: string; ageS: number }> = [];
      for (const [path, at] of edits) {
        const age = now - at;
        if (age > EDIT_RISK_WINDOW_MS) continue;
        // cbm cites a file either as a repo-relative path (search_code,
        // check_index_coverage) or as a fully qualified name
        // (home-brady-code-cardsearch.src.logic.terrain.grid.quantile), where the
        // file extension is dropped. Match both; do NOT match bare basenames —
        // `index.ts` / `types.ts` would flag unrelated files.
        const noExt = path.replace(/\.[^.]+$/, '');
        const dotted = path.replace(/\//g, '.');
        const dottedNoExt = noExt.replace(/\//g, '.');
        if (text.includes(path) || text.includes(dotted) || text.includes(dottedNoExt)) {
          hits.push({ path, ageS: Math.round(age / 1000) });
        }
      }
      if (hits.length === 0) {
        // Second failure mode, and the one that actually burns trust: a file this
        // session just created is not in the graph yet, so the lookup returns 0 and
        // reads as "the graph is broken". Say which is more likely.
        const recent = [...edits.entries()]
          .map(([path, at]) => ({ path, ageS: Math.round((now - at) / 1000) }))
          .filter((h) => h.ageS * 1000 <= EDIT_RISK_WINDOW_MS)
          .sort((a, b) => a.ageS - b.ageS)
          .slice(0, 3);
        if (recent.length === 0 || !EMPTY_RESULT_RE.test(text)) return;
        const note2 =
          `[cbm-fresh] 0 results, but this session wrote ${recent.map((h) => `${h.path} (${h.ageS}s ago)`).join(', ')}. ` +
          `The watcher commits a new file in ~4-20s, so a miss this soon after a write is index lag, not absence: ` +
          `read the file, or re-query after the next tool call.`;
        if (text.includes('[cbm-fresh]')) return;
        await debugLog(toolName, `zero-result note: ${recent.map((h) => `${h.path}@${h.ageS}s`).join(' ')}`);
        return { content: [{ type: 'text', text: `${text}\n${note2}` }] };
      }

      const listed = hits
        .slice(0, 4)
        .map((h) => `${h.path} (${h.ageS}s ago)`)
        .join(', ');
      const more = hits.length > 4 ? ` +${hits.length - 4} more` : '';
      const note =
        `[cbm-fresh] This result references file(s) you edited in this session: ${listed}${more}. ` +
        `The index watcher commits in ~4-15s, so snippets and line ranges for those paths may predate the edit. ` +
        `For the current bytes of a just-edited file use read; the graph stays authoritative for callers, blast radius and symbol lookup.`;

      if (text.includes('[cbm-fresh]')) return;
      await debugLog(toolName, `cite note: ${hits.map((h) => `${h.path}@${h.ageS}s`).join(' ')}`);
      return { content: [{ type: 'text', text: `${note}\n${text}` }] };
    } catch {
      // Fail-open: a broken freshness note must never block a retrieval call.
      return;
    }
  });
}
