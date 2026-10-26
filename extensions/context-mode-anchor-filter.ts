// PURPOSE: keep context-mode's per-turn routing anchor honest. context-mode 1.0.169
// appends "context-mode active. Hierarchy: ..." to pi's system prompt every turn and
// routes to ctx_* tools even when they are denied via ~/.pi/agent/tool-deny.json, so
// the model gets pointed at tools it cannot call.
//   - `context_with_system` is the reliable hook: it runs while the final request
//     transcript is assembled, i.e. AFTER every before_agent_start handler, so
//     extension ordering cannot hide the anchor from us (verified: a local
//     extension's before_agent_start handler runs BEFORE the context-mode package
//     handler and therefore sees no anchor).
//   - the before_agent_start handler is a cheap early attempt, kept because it is a
//     no-op whenever the anchor is not visible yet.
// INPUT: context_with_system event.messages, before_agent_start event.systemPrompt,
//        ~/.pi/agent/tool-deny.json ({ "deny": ["tool_name", ...] })
// MUTATION: returns { messages } / { systemPrompt } with the anchor's denied-tool
//        clauses removed when present; undefined when nothing changed. Appends one
//        diagnostic line per hook to ~/.pi/agent/context-mode-anchor-debug.log.
// DETERMINISM: pure string filtering over the deny list; log timestamps are
//        diagnostic output only and never feed the prompt.
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Resolved per call so $TOOL_DENY_CONFIG can point tests at a temp file and an edit to
// the deny list takes effect on the next turn without a reload.
function denyPath() {
  return process.env.TOOL_DENY_CONFIG ?? join(homedir(), '.pi', 'agent', 'tool-deny.json');
}

const LOG_PATH = join(homedir(), '.pi', 'agent', 'context-mode-anchor-debug.log');
const ANCHOR_HEAD = 'context-mode active. ';
const HIERARCHY_HEAD = 'Hierarchy: ';

function loadDenySet() {
  try {
    const parsed = JSON.parse(readFileSync(denyPath(), 'utf8'));
    const deny = Array.isArray(parsed?.deny) ? parsed.deny : [];
    return new Set(deny.filter((n) => typeof n === 'string' && n.length > 0));
  } catch {
    return new Set();
  }
}

function log(tag, fields) {
  try {
    appendFileSync(LOG_PATH, new Date().toISOString() + ' [' + tag + '] ' + fields + '\n');
  } catch {
    /* diagnostic only */
  }
}

// Rewrite the anchor line only; every other line is returned untouched.
function cleanAnchorLine(line, denied, removed) {
  const start = line.indexOf(ANCHOR_HEAD);
  if (start === -1) return line;
  const prefix = line.slice(0, start);
  const clauses = line.slice(start + ANCHOR_HEAD.length).split('. ');
  const kept = [];
  for (const clause of clauses) {
    const names = clause.match(/ctx_[a-z_]+/g) ?? [];
    const bad = names.filter((n) => denied.has(n));
    if (bad.length === 0) {
      kept.push(clause);
      continue;
    }
    removed.push(...bad);
    if (clause.startsWith(HIERARCHY_HEAD)) {
      const chain = clause
        .slice(HIERARCHY_HEAD.length)
        .replace(/\.$/, '')
        .split(' > ')
        .filter((n) => !denied.has(n));
      if (chain.length > 0) kept.push(HIERARCHY_HEAD + chain.join(' > '));
    }
  }
  if (kept.length === 0) return prefix.trimEnd();
  const body = kept.join('. ').replace(/\.+$/, '');
  return prefix + ANCHOR_HEAD + body + '.';
}

function cleanAnchorText(text, denied, removed) {
  if (!text.includes(ANCHOR_HEAD + HIERARCHY_HEAD)) return text;
  return text
    .split('\n')
    .map((line) => (line.includes(ANCHOR_HEAD + HIERARCHY_HEAD) ? cleanAnchorLine(line, denied, removed) : line))
    .join('\n');
}

// System message content is either a string or an array of content blocks.
function cleanContent(content, denied, removed) {
  if (typeof content === 'string') return cleanAnchorText(content, denied, removed);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((block) => {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const text = cleanAnchorText(block.text, denied, removed);
      if (text !== block.text) {
        changed = true;
        return { ...block, text };
      }
    }
    return block;
  });
  return changed ? out : content;
}

export default function anchorFilter(pi) {
  pi.on('before_agent_start', async (event) => {
    const prompt = String(event?.systemPrompt ?? '');
    const denied = loadDenySet();
    const seen = prompt.includes(ANCHOR_HEAD + HIERARCHY_HEAD);
    const removed = [];
    const rewritten = cleanAnchorText(prompt, denied, removed);
    const changed = rewritten !== prompt;
    log(
      'anchor-filter:before_agent_start',
      'seen=' + seen + ' denied=' + denied.size + ' removed=' + JSON.stringify(removed) +
        ' changed=' + changed + ' promptLen=' + prompt.length,
    );
    if (!changed) return undefined;
    return { systemPrompt: rewritten };
  });

  pi.on('context_with_system', async (event) => {
    const messages = event?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    if (messages[0]?.role !== 'system') {
      log('anchor-filter:context_with_system', 'skipped: messages[0] is not a system message');
      return undefined;
    }
    const denied = loadDenySet();
    const removed = [];
    const content = cleanContent(messages[0].content, denied, removed);
    const changed = content !== messages[0].content;
    log(
      'anchor-filter:context_with_system',
      'denied=' + denied.size + ' removed=' + JSON.stringify(removed) + ' changed=' + changed +
        ' messages=' + messages.length,
    );
    if (!changed) return undefined;
    return { messages: [{ ...messages[0], content }, ...messages.slice(1)] };
  });
}
