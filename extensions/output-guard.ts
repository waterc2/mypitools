// PURPOSE: bound oversized tool I/O with reloadable local limits so models keep working
//          without pi compacting every few turns. Levers: (1) input pagination caps
//          for read/grep/graph (smooth Math.min clamp, no cliff), (2) bash output
//          head/tail clamp, (3) ctx_batch_execute report-noise strip, (4) ctx_execute /
//          ctx_execute_file echoed-script dedup + byte clamp.
// INPUT:   tool_call events (mutable `event.input`) and tool_result events whose
//          handler returns `{ content }` to replace the result. Event names and
//          field names follow docs/extensions.md: `tool_call` / `tool_result`,
//          `event.toolName`, `event.input`, `event.content`. (pi emits no
//          `before_tool_call` / `after_tool_call`; handlers on those never fire.)
// MUTATION: mutates event.input.limit / event.input.context for capped tools;
//          returns { content } from tool_result handlers to trim oversized text.
//          Everything else passes through untouched. structuredContent is
//          intentionally dropped when we replace content (TextContent-only tools
//          here); tools that can return structuredContent (search_graph) are capped
//          on input only and never rewritten.
// DETERMINISM: length/line counting with limits loaded at session_start; no randomness or clock.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const READ_MAX_LINES = 150;
const READ_DEFAULT_LINES = 100;
const GREP_MAX_LIMIT = 50;
const GREP_MAX_CONTEXT = 5;
const LS_MAX_LIMIT = 100;

// Per-tool input caps. `defaultWhenUnset` is only supplied where the tool's own
// default already exceeds the cap (pi's read default is 2000 lines, grep's is 100
// matches, find's is 1000 results). Where the tool's own default is already under
// the cap it is left alone, so the guard can only ever shrink a request, never enlarge it.
const INPUT_CAPS: Record<string, { cap: number; defaultWhenUnset?: number }> = {
  read: { cap: READ_MAX_LINES, defaultWhenUnset: READ_DEFAULT_LINES },
  grep: { cap: GREP_MAX_LIMIT, defaultWhenUnset: GREP_MAX_LIMIT },
  find: { cap: GREP_MAX_LIMIT, defaultWhenUnset: GREP_MAX_LIMIT },
  // pi's ls defaults to 500 entries / 50KB — far more than the small-window model
  // should absorb in one call.
  ls: { cap: LS_MAX_LIMIT, defaultWhenUnset: LS_MAX_LIMIT },
  search_graph: { cap: GREP_MAX_LIMIT },
};
const READ_BUDGET = 15000;
const BASH_BUDGET = 8000;
const CTX_BUDGET = 3000;
// Output byte budgets, sized from the last 30 sessions so each clamp only ever
// touches the tail of that tool's own distribution and typical calls pass through
// untouched: ctx_execute p95 8.6k / max 36.5k.
const CTX_EXEC_BUDGET = 8000;
// grep is pi's built-in search tool now (it replaces the anchor_grep/ffgrep pair
// this guard used to clamp). grep's own ceiling is 50KB, so this is the tighter
// bound; sized on the measured old surface (p95 5.2k / max 13.9k).
const GREP_BUDGET = 6000;
// ls clamped too: pi's own ceiling is 500 entries / 50KB, and a repo-root listing
// is the usual offender once `ls` is an active tool (2026-10-01 defaultTools change).
const LS_BUDGET = 4000;
// Only dedup an echoed script when it is big enough to be worth the risk of a
// mismatched fence; small scripts stay verbatim.
const ECHO_MIN_CHARS = 1200;

function positiveInt(value: any): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export default function (pi: any) {
  // Keep conservative defaults for missing/invalid config; load only at session
  // startup/reload, not once per tool call. Each extension runtime owns its limits.
  let caps = { ...INPUT_CAPS };
  let budgets = { read: READ_BUDGET, bash: BASH_BUDGET, ctxBatch: CTX_BUDGET, ctxExecute: CTX_EXEC_BUDGET };
  pi.on('session_start', () => {
    caps = { ...INPUT_CAPS };
    budgets = { read: READ_BUDGET, bash: BASH_BUDGET, ctxBatch: CTX_BUDGET, ctxExecute: CTX_EXEC_BUDGET };
    try {
      const raw = JSON.parse(readFileSync(join(homedir(), '.pi', 'agent', 'output-guard.json'), 'utf8'));
      const bounded = (value: any, fallback: number, max: number) => {
        const n = positiveInt(value);
        return n === undefined ? fallback : Math.min(n, max);
      };
      const max = bounded(raw.readMaxLines, READ_MAX_LINES, 2000);
      caps.read = { cap: max, defaultWhenUnset: Math.min(bounded(raw.readDefaultLines, READ_DEFAULT_LINES, 2000), max) };
      budgets = {
        read: bounded(raw.readChars, READ_BUDGET, 50000),
        bash: bounded(raw.bashChars, BASH_BUDGET, 50000),
        ctxBatch: bounded(raw.ctxBatchChars, CTX_BUDGET, 50000),
        ctxExecute: bounded(raw.ctxExecuteChars, CTX_EXEC_BUDGET, 50000),
      };
    } catch {
      // Missing or malformed configuration retains the conservative defaults.
    }
  });

  // 1) Input guard: monotonic clamp; smaller explicit requests stay smaller.
  pi.on('tool_call', async (event: any) => {
    const input = event?.input;
    if (!input || typeof input !== 'object') return;
    const toolName = event.toolName;
    try {
      const spec = caps[toolName];
      if (!spec) return;
      const requested = positiveInt(input.limit) ?? spec.defaultWhenUnset;
      if (requested !== undefined) input.limit = Math.min(requested, spec.cap);
      if (toolName === 'grep') {
        const context = positiveInt(input.context);
        if (context !== undefined) input.context = Math.min(context, GREP_MAX_CONTEXT);
      }
    } catch {
      // A throwing tool_call handler blocks the tool as a fail-safe
      // (docs/extensions.md); a failed clamp must not. Pass the call through.
    }
  });

  // 2) Output guards.
  // Keep the head and tail of an oversized text around an omission marker. Head
  // lines are budget-driven when `headLines` is omitted, so a clamp never discards
  // more than the byte budget forces. Fails over to a character-level clamp when
  // the text is one pathological long line (e.g. a JSON dump / minified file) so
  // line-count truncation alone cannot shrink it.
  function offsetHint(text: string): string {
    // pi's own footer carries the exact resume position; re-emit it so the model
    // pages forward instead of guessing an offset.
    const found = text.match(/offset=(\d+)/g);
    if (!found || found.length === 0) return '';
    return ` ${found[found.length - 1]} to continue.`;
  }

  function charClamp(text: string, budget: number, note: string, hint: string): string {
    const keep = Math.max(0, Math.floor(budget / 2));
    if (keep === 0 || text.length <= keep * 2) return text;
    const omittedChars = text.length - keep * 2;
    return `${text.slice(0, keep)}\n\n... [Truncated ${omittedChars} chars (single-line payload); ${note}${hint}] ...\n\n${text.slice(-keep)}`;
  }

  // ctx_execute / ctx_execute_file echo the submitted script at the head of the
  // result. The model already paid for that text in its own toolCall arguments,
  // so an exact echo is pure duplication. Strip it only when the fenced block
  // equals the call's `code` argument (after trimming); a mismatched, unterminated,
  // or absent fence never removes real output.
  function stripEchoedCode(text: string, input: any): string {
    const code = typeof input?.code === 'string' ? input.code : undefined;
    if (!code || code.trim().length < ECHO_MIN_CHARS) return text;
    const open = text.match(/^```[A-Za-z0-9_-]*\n/);
    if (!open) return text;
    const close = text.indexOf('\n```', open[0].length);
    if (close === -1) return text;
    const echoed = text.slice(open[0].length, close);
    if (echoed.trim() !== code.trim()) return text;
    return text.slice(close + 4).replace(/^\n+/, '');
  }

  function clampText(text: string, opts: { headLines?: number; tailLines: number; budget: number; note: string; tailReserve?: number }): string {
    const lines = text.split('\n');
    const hint = offsetHint(text);
    const tailReserve = Math.min(opts.tailReserve ?? Math.min(3000, Math.floor(opts.budget * 0.25)), Math.floor(opts.budget / 2));

    // The head is byte-capped whether headLines was requested (bash asks for 30)
    // or computed: an explicit line count must not smuggle a 45KB single-line dump
    // past the budget.
    const headCap = opts.budget - tailReserve;
    const headLimit = Math.min(opts.headLines ?? lines.length, lines.length);
    let headLines = 0;
    let used = 0;
    while (headLines < headLimit && used + lines[headLines].length + 1 <= headCap) {
      used += lines[headLines].length + 1;
      headLines++;
    }
    if (headLines <= 0) return charClamp(text, opts.budget, opts.note, hint);

    let tailLines = 0;
    let tailUsed = 0;
    for (let i = lines.length - 1; i >= headLines && tailLines < opts.tailLines; i--) {
      const cost = lines[i].length + 1;
      if (tailUsed + cost > tailReserve) break;
      tailUsed += cost;
      tailLines++;
    }

    // tailLines === 0 can only mean the last line alone is longer than the tail
    // reserve (a one-line JSON dump, a minified blob). Line counting would then
    // keep the head and silently drop everything past it, so fall over to the
    // character clamp, which keeps a head and a tail in bytes instead of lines.
    if (tailLines === 0 && lines.length > headLines) return charClamp(text, opts.budget, opts.note, hint);
    const head = lines.slice(0, headLines).join('\n');
    const tail = tailLines > 0 ? lines.slice(lines.length - tailLines).join('\n') : '';
    const keptChars = head.length + (tail ? tail.length + 1 : 0);
    const omittedLines = lines.length - headLines - tailLines;
    const omittedChars = Math.max(0, text.length - keptChars);
    const marker = `\n\n... [Truncated ${omittedLines} lines / ${omittedChars} chars; ${opts.note}${hint}] ...\n\n`;
    const clamped = tail ? `${head}${marker}${tail}` : `${head}${marker}`;
    if (clamped.length >= text.length) return text;
    if (clamped.length > opts.budget + 2000) return charClamp(text, opts.budget, opts.note, hint);
    return clamped;
  }

  pi.on('tool_result', async (event: any) => {
    const { toolName, content } = event ?? {};
    if (!Array.isArray(content)) return;
    const texts = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text);
    if (texts.length === 0) return;
    const text = texts.join('\n');

    let next: string | undefined;

    if (toolName === 'bash' && text.length > budgets.bash) {
      // bash itself already keeps last 2000 lines / 50KB; shrink further for the
      // small-window model. Head/tail around the omission marker.
      next = clampText(text, { headLines: 30, tailLines: 50, budget: budgets.bash, note: 'output incomplete; narrow the command or use its full-output path if provided; pipe heavy output to a file next time' });
    } else if (toolName === 'ctx_batch_execute') {
      // Strip the "Executed N commands ...\n\n## Commands\n\n## Indexed Sections"
      // metadata head in one pass; keep the actual per-query extracted sections.
      // Report skeleton (verified against real outputs): stats line, ## Commands,
      // ## Indexed Sections, then one ## <query title> per query each with ### sections.
      const reportHead = /^Executed \d+ commands[^\n]*\n+## Commands[\s\S]*?\n## Indexed Sections[\s\S]*?(?=\n## |$)/;
      const stripped = text.replace(reportHead, '').replace(/\n{3,}/g, '\n\n').trim();
      // Fallback: if the structure was unexpected and stripping ate everything,
      // keep the raw text (better to be verbose than to hide a failure).
      if (stripped.length < 20) return;
      next = stripped.length > budgets.ctxBatch ? clampText(stripped, { tailLines: 20, budget: budgets.ctxBatch, note: 'use ctx_search to retrieve the rest' }) : stripped;
    } else if (toolName === 'ctx_execute' || toolName === 'ctx_execute_file') {
      // Two levers: drop the echoed script, then clamp what the script printed.
      // Tail-heavy because tracebacks and the summary a script prints land last.
      const stripped = stripEchoedCode(text, event.input);
      if (stripped.length > budgets.ctxExecute) {
        next = clampText(stripped, { tailLines: 30, tailReserve: 2000, budget: budgets.ctxExecute, note: 'print less (aggregate inside the script) or pass intent and retrieve with ctx_search' });
      } else if (stripped !== text) {
        next = stripped;
      }
    } else if (toolName === 'grep' && text.length > GREP_BUDGET) {
      // Head-heavy: the file headers and the first matches are what gets acted on.
      // grep has no paging, so the fix is a narrower pattern/glob, not a second call.
      next = clampText(text, { tailLines: 8, tailReserve: 800, budget: GREP_BUDGET, note: 'narrow the pattern or add glob/path' });
    } else if (toolName === 'ls' && text.length > LS_BUDGET) {
      // Head-heavy: sorted entries, so the head is the part the model can act on;
      // the tail only proves how much was omitted.
      next = clampText(text, { tailLines: 6, tailReserve: 600, budget: LS_BUDGET, note: 'narrow the path or pass a smaller limit' });
    } else if (toolName === 'read' && text.length > budgets.read) {
      // Last-resort read clamp for pathological wide pages; pi already capped the
      // line count, this caps the bytes of what survives.
      next = clampText(text, { tailLines: 20, budget: budgets.read, note: 'incomplete page: re-read a smaller range from the last contiguous visible line; do not parse as a complete file' });
    }

    if (next === undefined || next === text) return;
    return { content: [{ type: 'text', text: next }] };
  });
}
