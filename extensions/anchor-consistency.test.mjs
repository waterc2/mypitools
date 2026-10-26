// PURPOSE: guard the invariant that broke on 2026-10-01. context-mode's routing anchor
//          (node_modules patch in adapters/pi/extension.js), its tool-result hints
//          (server.js), the user's own AGENTS.md guidance, and the ctx_* registration
//          set (local patch in adapters/pi/mcp-bridge.js) must agree: every ctx_* tool
//          the model is told about must actually be registered, therefore callable.
//          The v1 bridge patch (hard-coded 3-tool whitelist) broke this and the model
//          called a tool that did not exist: "Tool ctx_search not found".
// INPUT:  ~/.pi/agent/tool-deny.json
//         ~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js
//         ~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js
//         ~/.pi/agent/npm/node_modules/context-mode/build/server.js
//         ~/.pi/agent/npm/node_modules/context-mode/build/adapters/openclaw/mcp-tools.js
//         ~/code/{cardsearch,AI-cardgame1}/AGENTS.md
// READ-ONLY: evaluates the shipped bridge snippet in-process; writes nothing.
// DETERMINISM: pure file reads + set arithmetic; no clock, no network.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const A = join(homedir(), '.pi', 'agent');
const CM = join(A, 'npm', 'node_modules', 'context-mode', 'build');
const read = (p) => readFileSync(p, 'utf8');

let pass = 0, fail = 0;
const chk = (name, cond, info = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${info}`); }
  else { fail++; console.log(`  FAIL ${name} ${info}`); }
};

const denyPath = process.env.TOOL_DENY_CONFIG ?? join(A, 'tool-deny.json');
const deny = new Set(JSON.parse(read(denyPath)).deny);

// ---- A. registered set: evaluate the SHIPPED bridge patch, not a copy of it ----
const bridge = read(join(CM, 'adapters', 'pi', 'mcp-bridge.js'));
const from = bridge.indexOf('const CTX_DENY_SOURCE');
const to = bridge.indexOf('const compactDescription');
chk('bridge carries the v2 marker (CTX_DENY_SOURCE)', from !== -1);
chk('v1 hard-coded whitelist is gone', !bridge.includes('ALLOWED_CTX_TOOLS'));
const snippet = bridge.slice(from, to);
const { CTX_DENY_SOURCE, blockedCtxTool } = eval(`${snippet}\n({ CTX_DENY_SOURCE, blockedCtxTool });`);
chk('bridge read the real deny file', CTX_DENY_SOURCE instanceof Set && CTX_DENY_SOURCE.size === deny.size,
  `deny=${CTX_DENY_SOURCE.size}`);

// The universe of ctx_* tools the MCP server can hand out.
const toolsUniverse = [...new Set([...read(join(CM, 'adapters', 'openclaw', 'mcp-tools.js'))
  .matchAll(/name:\s*"(ctx_[a-z_]+)"/g)].map((m) => m[1]))];
const registered = new Set(toolsUniverse.filter((n) => !blockedCtxTool(n)));
console.log(`  universe=${toolsUniverse.length} registered=[${[...registered].sort().join(', ')}]`);
chk('the three core tools are always registered',
  ['ctx_execute', 'ctx_batch_execute', 'ctx_execute_file'].every((n) => registered.has(n)));
chk('ctx_search is registered (its own truncation hints tell the model to call it)',
  registered.has('ctx_search'));
chk('ctx_fetch_and_index is registered (the anchor routes web pages to it)',
  registered.has('ctx_fetch_and_index'));
chk('denied tools are NOT registered',
  [...deny].filter((n) => n.startsWith('ctx_')).every((n) => !registered.has(n)));

// ---- B. fail closed when the deny file is missing / corrupt ----
{
  const saved = process.env.TOOL_DENY_CONFIG;
  process.env.TOOL_DENY_CONFIG = '/tmp/anchor-consistency/nope.json';
  const { blockedCtxTool: blocked } = eval(`${snippet}\n({ blockedCtxTool });`);
  const fallback = toolsUniverse.filter((n) => !blocked(n));
  chk('missing deny file -> only the three core tools', fallback.length === 3, `[${fallback.join(', ')}]`);
  if (saved === undefined) delete process.env.TOOL_DENY_CONFIG; else process.env.TOOL_DENY_CONFIG = saved;
}

// ---- C. the anchor's own advertised set (real arrays from the node_modules patch) ----
const ext = read(join(CM, 'adapters', 'pi', 'extension.js'));
const order = [...(ext.match(/const order = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/"(ctx_[a-z_]+)"/g)].map((m) => m[1]);
const routes = [...(ext.match(/const routes = \[([\s\S]*?)\]\s*\n\s*\.filter/s)?.[1] ?? '').matchAll(/\["(ctx_[a-z_]+)"/g)].map((m) => m[1]);
const advertised = [...new Set([...order, ...routes])].filter((n) => !deny.has(n));
console.log(`  anchor advertises=[${advertised.join(', ')}]`);
const ghosts = advertised.filter((n) => !registered.has(n));
chk('anchor advertises only registered tools', ghosts.length === 0, ghosts.length ? `ghosts=[${ghosts.join(', ')}]` : '');

// ---- D. context-mode's own in-result hints ----
const hints = [...read(join(CM, 'server.js')).matchAll(/ctx_[a-z_]+/g)].map((m) => m[0]);
const hintGhosts = [...new Set(hints)].filter((n) => !registered.has(n) && !deny.has(n));
chk('server.js hints reference only registered or explicitly denied tools',
  hintGhosts.length === 0, hintGhosts.length ? `[${hintGhosts.join(', ')}]` : '');

// ---- E. the user's project guidance (AGENTS.md) ----
for (const proj of ['cardsearch', 'AI-cardgame1']) {
  const p = join(homedir(), 'code', proj, 'AGENTS.md');
  let text = '';
  try { text = read(p); } catch { console.log(`  SKIP AGENTS.md(${proj}) not present`); continue; }
  const named = [...new Set([...text.matchAll(/ctx_[a-z_]+/g)].map((m) => m[0]))];
  const bad = named.filter((n) => !registered.has(n) && !deny.has(n));
  chk(`AGENTS.md(${proj}) names no unregistered ctx tool`, bad.length === 0, bad.length ? `[${bad.join(', ')}]` : `named=[${named.join(', ')}]`);
  const dead = named.filter((n) => deny.has(n));
  if (dead.length) console.log(`  NOTE AGENTS.md(${proj}) documents denied tools (calls will be refused): [${dead.join(', ')}]`);
  // non-ctx tool names the guide tells the model to use, checked against the live surface
  const others = [...new Set([...text.matchAll(/`([a-z][a-z0-9_]{2,})`/g)].map((m) => m[1]))]
    .filter((n) => /^(search_code|search_graph|trace_path|get_code_snippet|mcpScript|fffind|ffgrep|anchor_grep|replace_within|undo_last_change|hashline)$/.test(n));
  const gone = others.filter((n) => deny.has(n));
  if (gone.length) console.log(`  NOTE AGENTS.md(${proj}) still tells the model to call removed/denied tools: [${gone.join(', ')}]`);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} pass / ${fail} fail`);
if (fail) process.exitCode = 1;
