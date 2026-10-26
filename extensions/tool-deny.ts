// PURPOSE: remove a configurable denylist of tools from pi's active tool set,
//          so extension-provided tools (ctx_*, search_code, ...) can be hidden
//          individually. pi's built-in `--exclude-tools` / `settings.defaultTools`
//          only cover BUILT-IN tools and cannot reach extension tools, and pi
//          activates every newly registered tool by default.
// INPUT:   ~/.pi/agent/tool-deny.json  ->  { "deny": ["tool_name", ...] }
//          Missing/corrupt file = empty denylist = no-op (fail open, never throws).
// MUTATION: pi's ACTIVE tool list (pi.setActiveTools) plus a `tool_call` guard
//           that refuses denylisted tools at execution time. The tool registry is
//           never touched, so a denied tool stays registered and is restored the
//           moment it is removed from the JSON + /reload.
// DETERMINISM: pure name filtering; no randomness, no clock.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_PATH = join(homedir(), '.pi', 'agent', 'tool-deny.json');

function loadDenySet() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    const deny = Array.isArray(parsed?.deny) ? parsed.deny : [];
    return new Set(deny.filter((n) => typeof n === 'string' && n.length > 0));
  } catch {
    return new Set();
  }
}

export default function toolDeny(pi) {
  let deny = loadDenySet();

  // Only touch setActiveTools when the filter actually changes something, so a
  // steady state never emits a tool-set transition (which would bust the
  // provider's cached prompt prefix).
  function apply() {
    let active;
    try {
      active = pi.getActiveTools();
    } catch {
      return; // extension loading phase: not ready yet
    }
    if (!Array.isArray(active) || active.length === 0) return;
    const next = active.filter((name) => !deny.has(name));
    if (next.length === active.length) return;
    pi.setActiveTools(next);
  }

  // Re-read the JSON at session start so edits take effect on /reload.
  pi.on('session_start', async () => {
    deny = loadDenySet();
    apply();
  });

  // Re-assert every turn: later-registered tools (MCP adapter sync, lazy
  // registration, other extensions) would otherwise re-activate themselves.
  // The JSON is re-read here too, so an edit takes effect on the next turn
  // without waiting for a /reload.
  pi.on('before_agent_start', async () => {
    deny = loadDenySet();
    apply();
  });

  // Hard guard. pi freezes the session's initial tool definitions in the prompt
  // prefix (for provider cache stability) and only announces removals through a
  // transcript delta, so a denied tool stays *callable* by name even after
  // setActiveTools dropped it. Refuse it at execution time instead of trusting
  // the active list alone.
  pi.on('tool_call', async (event) => {
    if (!deny.has(event.toolName)) return undefined;
    return {
      block: true,
      reason: `Tool "${event.toolName}" is denied by ~/.pi/agent/tool-deny.json`
    };
  });

  pi.registerCommand('tool-deny', {
    description: 'Show the active tool denylist (edit ~/.pi/agent/tool-deny.json, then /reload)',
    handler: async (_args, ctx) => {
      deny = loadDenySet();
      const active = pi.getActiveTools();
      const removed = [...deny].filter((n) => !active.includes(n));
      const still = [...deny].filter((n) => active.includes(n));
      const lines = [
        `denylist (${deny.size}): ${[...deny].join(', ') || '(empty)'}`,
        `out of the active list: ${removed.length}${removed.length ? ' -> ' + removed.join(', ') : ''}`,
        still.length ? `STILL ACTIVE (filter missed them): ${still.join(', ')}` : 'no denylist entry is still active',
        'hard guard: tool_call blocks every denylist entry at execution time',
        'note: pi keeps the session-start tool definitions in the prompt prefix, so a denied tool can still be listed until the next session',
        `active tools: ${active.length}`,
      ];
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
