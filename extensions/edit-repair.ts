// PURPOSE: cut the `edit` failure rate. Over 2026-10-09..12 there were 135 failed
//          edit calls (8% of 1692); 58% edited a file never read in-session, and
//          94/135 were multi-edit batches killed by one bad sub-edit. pi already
//          does exact + NFKC fuzzy matching, so the failures that survive are
//          indentation mismatches, duplicates, no-ops, overlaps and stale text.
// INPUT:   `tool_call` events for `edit` (input = { path, edits:[{oldText,newText}] },
//          already normalized by pi's prepareArguments). `tool_result` events as a
//          backstop for any not-found pi still emits.
// MUTATION: for an oldText that pi cannot find, attempts an indentation-tolerant
//          block match. On a UNIQUE match it rewrites edits[i].oldText to the file's
//          exact bytes and re-indents edits[i].newText through the model-indent ->
//          file-indent map, so pi's own exact replacement succeeds. When repair is
//          impossible it blocks with a diagnosis + the verbatim closest region.
//          Structural faults (empty / no-op / duplicate / overlap) are blocked with
//          precise, actionable messages instead of pi's terse ones.
// DETERMINISM: pure text processing + one file read per edit call; no randomness,
//          no clock, no config, no toggle. Any unexpected error fails open (pass
//          through) so the guard can never make an edit worse than pi alone.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

// --- Mirrors pi's dist/core/tools/edit-diff.js normalizeForFuzzyMatch exactly, so
// --- the "would pi find this?" predicate is trustworthy. ---
function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function keyLine(line: string): string {
  return normalizeForFuzzyMatch(line);
}

/** Line key with leading indentation removed: the extra tolerance this guard adds. */
function keyNoIndent(line: string): string {
  return normalizeForFuzzyMatch(line).replace(/^[ \t]+/, '');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let at = 0;
  for (;;) {
    const i = haystack.indexOf(needle, at);
    if (i === -1) return count;
    count++;
    at = i + needle.length;
  }
}

function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

function gcdList(values: number[]): number {
  let g = 0;
  for (const v of values) {
    let a = Math.abs(v);
    let b = g;
    while (b) [a, b] = [b, a % b];
    g = a;
  }
  return g;
}

/** Would pi's exact+fuzzy pipeline find this oldText? (BOM already stripped, LF.) */
function piWouldFind(content: string, oldText: string): boolean {
  return normalizeForFuzzyMatch(content).includes(normalizeForFuzzyMatch(oldText));
}

type Repair = { block: string[]; realOld: string };

/**
 * Find the unique run of file lines whose indentation-insensitive keys equal the
 * oldText lines. Returns undefined unless there is exactly one such run, so an
 * ambiguous match is never silently rewritten.
 */
function tryIndentRepair(contentLines: string[], oldText: string): Repair | undefined {
  const hadTrailingNewline = oldText.endsWith('\n');
  const core = hadTrailingNewline ? oldText.slice(0, -1) : oldText;
  const oldLines = core.split('\n');
  const keys = oldLines.map(keyNoIndent);
  if (keys.join('').trim() === '') return undefined;
  const fileKeys = contentLines.map(keyNoIndent);
  const hits: number[] = [];
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    let equal = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (fileKeys[i + j] !== keys[j]) {
        equal = false;
        break;
      }
    }
    if (equal) hits.push(i);
  }
  if (hits.length !== 1) return undefined;
  const start = hits[0];
  const block = contentLines.slice(start, start + oldLines.length);
  const endsWithNewline = start + oldLines.length < contentLines.length;
  const realOld = block.join('\n') + (hadTrailingNewline && endsWithNewline ? '\n' : '');
  return { block, realOld };
}

/**
 * Build a leading-whitespace converter from the model's block to the file's block.
 * Returns undefined on a conflicting map (same model indent -> two file indents),
 * which means the match is not a clean re-indentation and must not be repaired.
 */
function buildIndentConverter(modelBlock: string[], fileBlock: string[]): ((ws: string) => string) | undefined {
  const map = new Map<string, string>();
  for (let i = 0; i < modelBlock.length; i++) {
    if (modelBlock[i].trim() === '') continue; // blank lines carry no indent signal
    const m = (modelBlock[i].match(/^[ \t]*/) ?? [''])[0];
    const f = (fileBlock[i].match(/^[ \t]*/) ?? [''])[0];
    const existing = map.get(m);
    if (existing !== undefined && existing !== f) return undefined;
    map.set(m, f);
  }
  if (map.size === 0) return undefined;

  const allSpaces = [...map.keys()].every((k) => /^ *$/.test(k)) && [...map.values()].every((v) => /^ *$/.test(v));
  if (allSpaces) {
    // Derive a per-level width ratio (handles "model 2 spaces, file 4 spaces" at
    // any nesting depth) when the mapping is consistent.
    const widths = [...map.keys()].map((k) => k.length).filter((w) => w > 0);
    const modelUnit = gcdList(widths);
    let fileUnit: number | null = null;
    let consistent = modelUnit > 0;
    if (consistent) {
      for (const [k, v] of map) {
        if (k.length === 0) continue;
        const level = k.length / modelUnit;
        if (!Number.isInteger(level) || level <= 0 || v.length % level !== 0) {
          consistent = false;
          break;
        }
        const fu = v.length / level;
        if (fileUnit === null) fileUnit = fu;
        else if (fileUnit !== fu) {
          consistent = false;
          break;
        }
      }
    }
    if (consistent && fileUnit !== null && modelUnit > 0) {
      const unit = modelUnit;
      const out = fileUnit;
      return (ws) => {
        const exact = map.get(ws);
        if (exact !== undefined) return exact;
        if (!/^ *$/.test(ws)) return ws;
        const level = ws.length / unit;
        return Number.isInteger(level) ? ' '.repeat(Math.max(0, level * out)) : ws;
      };
    }
  }

  // Fallback: exact indent map, extending the deepest known key additively.
  return (ws) => {
    const exact = map.get(ws);
    if (exact !== undefined) return exact;
    let best: string | null = null;
    for (const k of map.keys()) {
      if (k.length <= ws.length && (best === null || k.length > best.length)) best = k;
    }
    if (best === null) return ws;
    const tail = ws.slice(best.length);
    return map.get(best)! + (/^[\t ]*$/.test(tail) ? tail : '');
  };
}

function reindent(text: string, convert: (ws: string) => string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line === '') return line;
      const ws = (line.match(/^[ \t]*/) ?? [''])[0];
      const mapped = convert(ws);
      return mapped === ws ? line : mapped + line.slice(ws.length);
    })
    .join('\n');
}

/** Line numbers (1-based) where a duplicate oldText occurs. */
function locateLines(contentLines: string[], oldText: string): number[] {
  const key = normalizeForFuzzyMatch(oldText);
  const found: number[] = [];
  if (!key.includes('\n')) {
    for (let i = 0; i < contentLines.length; i++) if (normalizeForFuzzyMatch(contentLines[i]).includes(key)) found.push(i + 1);
    return found;
  }
  const keys = oldText.split('\n').map(keyNoIndent);
  for (let i = 0; i + keys.length <= contentLines.length; i++) {
    let equal = true;
    for (let j = 0; j < keys.length; j++) {
      if (keyNoIndent(contentLines[i + j]) !== keys[j]) {
        equal = false;
        break;
      }
    }
    if (equal) found.push(i + 1);
  }
  return found;
}

/** Best-effort nearest region, rendered verbatim with line numbers. */
function diagnose(contentLines: string[], oldText: string): string {
  const oldLines = oldText.split('\n');
  const keys = oldLines.map(keyNoIndent);
  const k = oldLines.length;
  let bestStart = 0;
  let bestScore = -1;
  for (let i = 0; i + k <= contentLines.length; i++) {
    let score = 0;
    for (let j = 0; j < k; j++) if (keyNoIndent(contentLines[i + j]) === keys[j]) score++;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  if (bestScore <= 0) {
    const firstKey = keys.find((x) => x.trim() !== '');
    const probe = firstKey?.slice(0, 60);
    if (probe) {
      for (let i = 0; i < contentLines.length; i++) {
        if (keyNoIndent(contentLines[i]).includes(probe)) {
          bestStart = i;
          bestScore = 0;
          break;
        }
      }
    }
  }
  if (bestScore < 0) return 'No similar region exists in the current file; the text may never have been present as written.';
  const end = Math.min(contentLines.length, bestStart + k);
  const width = String(end).length;
  const body = contentLines
    .slice(bestStart, end)
    .map((line, i) => `${String(bestStart + i + 1).padStart(width)}| ${line}`)
    .join('\n');
  return `Closest region in the current file (lines ${bestStart + 1}-${end}):\n${body}`;
}

async function readContent(cwd: string, path: string): Promise<string | undefined> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const raw = await readFile(absolute, 'utf-8');
  return normalizeToLF(stripBom(raw));
}

const REPAIR_NOTE =
  '(oldText did not match because of indentation; it was relocated to the exact file text and your newText was re-indented to match. Verify the diff.)';

export default function editRepair(pi: any) {
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (event?.toolName !== 'edit') return undefined;
    const input = event.input;
    if (!input || typeof input !== 'object') return undefined;
    const path = input.path;
    const edits = input.edits;
    if (typeof path !== 'string' || !Array.isArray(edits) || edits.length === 0) return undefined;

    let content: string | undefined;
    try {
      content = await readContent(ctx?.cwd ?? process.cwd(), path);
    } catch {
      return undefined; // unreadable -> let pi report the real error
    }
    if (content === undefined) return undefined;
    const contentLines = content.split('\n');

    try {
      const effective: { index: number; oldText: string }[] = [];

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (!edit || typeof edit !== 'object') continue;
        const oldText = normalizeToLF(typeof edit.oldText === 'string' ? edit.oldText : '');
        const newText = normalizeToLF(typeof edit.newText === 'string' ? edit.newText : '');

        if (oldText.length === 0) {
          return { block: true, reason: `edits[${i}] in ${path}: oldText is empty. Pass the exact existing text to replace.` };
        }
        if (oldText === newText) {
          return {
            block: true,
            reason: `edits[${i}] in ${path}: oldText and newText are identical, so the edit would change nothing. Make the replacement differ, or drop this edit.`,
          };
        }

        const occurrences = countOccurrences(normalizeForFuzzyMatch(content), normalizeForFuzzyMatch(oldText));
        if (occurrences > 1) {
          const at = locateLines(contentLines, oldText);
          const where = at.length ? ` (lines ${at.join(', ')})` : '';
          return {
            block: true,
            reason: `edits[${i}] in ${path}: oldText matches ${occurrences} places${where}. Include more surrounding context so the match is unique.`,
          };
        }

        if (piWouldFind(content, oldText)) {
          effective.push({ index: i, oldText });
          continue;
        }

        const repair = tryIndentRepair(contentLines, oldText);
        if (repair) {
          const convert = buildIndentConverter(oldText.split('\n'), repair.block);
          if (convert) {
            const repairedNew = reindent(newText, convert);
            edit.oldText = repair.realOld;
            edit.newText = repairedNew;
            effective.push({ index: i, oldText: repair.realOld });
            continue;
          }
        }

        return {
          block: true,
          reason:
            `edits[${i}] in ${path}: oldText was not found (pi exact+fuzzy match failed). ` +
            `This usually means the file changed since you last read it, or the text was written from memory. ` +
            `Re-read the file and copy oldText verbatim, including indentation.\n${diagnose(contentLines, oldText)}`,
        };
      }

      // Overlap pre-check (mirrors pi's own atomic batch rule).
      const base = normalizeForFuzzyMatch(content);
      const ranges = effective
        .map((e) => {
          const key = normalizeForFuzzyMatch(e.oldText);
          const at = base.indexOf(key);
          return at === -1 ? undefined : { index: e.index, start: at, end: at + key.length };
        })
        .filter((r): r is { index: number; start: number; end: number } => r !== undefined)
        .sort((a, b) => a.start - b.start);
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i - 1].end > ranges[i].start) {
          return {
            block: true,
            reason:
              `edits[${ranges[i - 1].index}] and edits[${ranges[i].index}] in ${path} target overlapping regions ` +
              `(around lines ${lineOfIndex(base, ranges[i - 1].start)} and ${lineOfIndex(base, ranges[i].start)}). ` +
              `Merge them into one edit or target disjoint regions.`,
          };
        }
      }

      return undefined; // repair mutations (if any) are already applied in place
    } catch {
      return undefined; // never let the guard block an edit it cannot reason about
    }
  });

  // Backstop: if pi still emits a raw not-found (predicate gap), append the region.
  pi.on('tool_result', async (event: any, ctx: any) => {
    if (event?.toolName !== 'edit' || !event.isError) return undefined;
    const text = Array.isArray(event.content) ? event.content.map((b: any) => b.text ?? '').join('') : '';
    if (!/Could not find the exact text|Could not find edits\[/.test(text)) return undefined;
    if (text.includes('Closest region') || text.includes('Re-read the file')) return undefined;
    const input = event.input;
    if (!input || typeof input.path !== 'string' || !Array.isArray(input.edits)) return undefined;
    try {
      const content = await readContent(ctx?.cwd ?? process.cwd(), input.path);
      if (content === undefined) return undefined;
      const m = text.match(/edits\[(\d+)\]/);
      const idx = m ? Number(m[1]) : 0;
      const edit = input.edits[idx];
      if (!edit || typeof edit.oldText !== 'string') return undefined;
      const extra = diagnose(content.split('\n'), normalizeToLF(edit.oldText));
      return { content: [...event.content, { type: 'text', text: `\n${extra}` }] };
    } catch {
      return undefined;
    }
  });
}

// Exported for the test harness.
export { normalizeForFuzzyMatch, tryIndentRepair, buildIndentConverter, reindent, diagnose, REPAIR_NOTE };
