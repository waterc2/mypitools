// Harness for output-guard.ts after the pi-hashline-edit-pro / @ff-labs/pi-fff
// removal: the guard now clamps pi's built-in read / grep / find instead of the
// extension-provided anchor_grep / ffgrep / fffind, and the diff-bloat branch is
// gone because core edit/write return a one-line summary (their diff lives in
// `details`, never in the model-visible content).
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL('/home/brady/.pi/agent/extensions/output-guard.ts').href);
const ext = mod.default;
const handlers = {};
const pi = { on: (name, fn) => { (handlers[name] ||= []).push(fn); } };
ext(pi);

const call = (toolName, input) => ({ type: 'tool_call', toolName, input });
const res = (toolName, text, input = {}) => ({ type: 'tool_result', toolName, toolCallId: 'x', input, content: [{ type: 'text', text }] });

async function out(toolName, text, input) {
  const ev = res(toolName, text, input);
  for (const h of handlers.tool_result) { const r = await h(ev, {}); if (r?.content) return r.content.map((b) => b.text).join('\n'); }
  return text; // untouched
}
async function inp(toolName, input) {
  const ev = call(toolName, input);
  for (const h of handlers.tool_call) await h(ev, {});
  return ev.input;
}

const L = (n, w) => Array.from({ length: n }, (_, i) => `${String(i).padStart(4, '0')}: a line of roughly ${'x'.repeat(Math.max(0, w - 24))} length`).join('\n');

let pass = 0, fail = 0;
const chk = (name, cond, info = '') => { if (cond) { pass++; console.log(`  PASS ${name} ${info}`); } else { fail++; console.log(`  FAIL ${name} ${info}`); } };

console.log('=== 1. grep 14k outlier ===');
{
  const raw = '=== src/logic/battle/commands/handlers.ts ===\n' + L(200, 70);
  const got = await out('grep', raw);
  chk('clamped under budget+slack', got.length < 7200, `in=${raw.length} out=${got.length}`);
  chk('head file header kept', got.startsWith('=== src/logic/battle/commands/handlers.ts ==='));
  chk('no bogus offset hint', !got.includes('to continue'));
  chk('tells how to narrow', got.includes('narrow the pattern'));
  chk('tail lines survive', /a line of roughly/.test(got.split('... [Truncated')[1] || ''));
}
console.log('=== 2. grep typical 3k result untouched ===');
{
  const raw = L(45, 60);
  chk('untouched', (await out('grep', raw)) === raw, `len=${raw.length}`);
}
console.log('=== 3. ctx_execute 36k with echoed script ===');
{
  const code = 'const fs=require("fs");\n' + Array.from({ length: 120 }, (_, i) => `const v${i} = ${i}; // padding line to make the script itself large ${i}`).join('\n');
  const body = Array.from({ length: 400 }, (_, i) => `row ${i}: ${'data'.repeat(12)}`).join('\n');
  const raw = '```javascript\n' + code + '\n```\n\n' + body;
  const got = await out('ctx_execute', raw, { code, language: 'javascript' });
  chk('echo stripped', !got.startsWith('```javascript'), `in=${raw.length} out=${got.length}`);
  chk('clamped under budget+slack', got.length < 10200, `out=${got.length}`);
  chk('tail rows survive', got.includes('row 399'));
  chk('tells how to shrink', got.includes('aggregate inside the script'));
}
console.log('=== 4. ctx_execute 5k with 3k echoed script: dedup only, no clamp ===');
{
  const code = Array.from({ length: 60 }, (_, i) => `const a${i} = ${i}; // echo-dedup padding line number ${i}`).join('\n');
  const body = Array.from({ length: 40 }, (_, i) => `summary line ${i}: ${'y'.repeat(60)}`).join('\n');
  const raw = '```shell\n' + code + '\n```\n\n' + body;
  const got = await out('ctx_execute', raw, { code });
  chk('echo stripped', !got.startsWith('```shell'), `in=${raw.length} out=${got.length}`);
  chk('output intact', got === body);
}
console.log('=== 5. ctx_execute fence does NOT match code -> output preserved ===');
{
  const code = Array.from({ length: 60 }, (_, i) => `const b${i} = ${i}; // mismatch padding line number ${i}`).join('\n');
  const raw = '```shell\nsome other text entirely\n```\n\n' + Array.from({ length: 200 }, (_, i) => `out ${i}: ${'z'.repeat(40)}`).join('\n');
  const got = await out('ctx_execute', raw, { code });
  chk('fence kept (no false strip)', got.includes('some other text entirely'), `out=${got.length}`);
  chk('still clamped', got.length < 10200 && got.includes('Truncated'), `out=${got.length}`);
  chk('tail preserved', got.includes('out 199'));
}
console.log('=== 6. ctx_execute unterminated fence -> no strip, clamped ===');
{
  const code = 'x'.repeat(2000);
  const raw = '```shell\n' + code + '\n' + 'tail '.repeat(2500);
  const got = await out('ctx_execute', raw, { code });
  chk('no strip on unterminated fence', got.includes('```shell'));
  chk('clamped', got.length < 10200, `in=${raw.length} out=${got.length}`);
}
console.log('=== 7. small ctx_execute untouched ===');
{
  const raw = '```python\nprint(1)\n```\n\n1\n';
  chk('untouched', (await out('ctx_execute', raw, { code: 'print(1)' })) === raw);
}
console.log('=== 8. regressions: bash / read / ctx_batch_execute ===');
{
  const b = L(300, 60);
  const gb = await out('bash', b);
  chk('bash clamped as before', gb.length < 9200 && gb.includes('Truncated'), `in=${b.length} out=${gb.length}`);
  const r = L(400, 60) + '\n[Showing lines 1-400 of 900. Use offset=401 to continue.]';
  const gr = await out('read', r);
  chk('read clamp keeps pi offset hint', gr.includes('offset=401 to continue'), `out=${gr.length}`);
  const cb = 'Executed 5 commands (345 lines, 15.5KB). Indexed 6 sections. Searched 5 queries.\n\n## Commands\n\n- a: `x`\n\n## Indexed Sections\n\n## q1\n\n### s1\n' + 'k'.repeat(6000);
  const gcb = await out('ctx_batch_execute', cb, {});
  chk('ctx_batch strip+clamp intact', !gcb.startsWith('Executed 5 commands') && gcb.length < 5200, `out=${gcb.length}`);
}
console.log('=== 8b. single-line dump at the tail is not dropped (bash JSON dump) ===');
{
  const dump = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i, name: 'minion-' + i, skills: 'x'.repeat(40) })) });
  const raw = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join('\n') + '\n' + dump;
  const got = await out('bash', raw);
  chk('clamped', got.length < 10200, `in=${raw.length} out=${got.length}`);
  chk('head survives', got.includes('log line 0'));
  chk('tail of the dump survives', got.includes('minion-399'));
}
console.log('=== 8c. core edit/write one-line results pass through untouched ===');
{
  const e = 'Successfully replaced 2 block(s) in src/logic/battle/ResolutionScheduler.ts.';
  chk('edit untouched', (await out('edit', e)) === e);
  const w = 'Successfully wrote to src/logic/battle/ResolutionScheduler.ts';
  chk('write untouched', (await out('write', w)) === w);
}
console.log('=== 9. input caps still applied (built-in surface) ===');
{
  const a = await inp('read', { path: 'f.ts', limit: 900 });
  chk('read limit capped to 150', a.limit === 150, JSON.stringify(a));
  const b = await inp('grep', { pattern: 'x', limit: 500, context: 20 });
  chk('grep limit capped 50 / context 5', b.limit === 50 && b.context === 5, JSON.stringify(b));
  const c = await inp('grep', { pattern: 'x' });
  chk('grep default (100) lowered to 50', c.limit === 50, JSON.stringify(c));
  const d = await inp('find', { pattern: 'x' });
  chk('find default (1000) lowered to 50', d.limit === 50, JSON.stringify(d));
  const e = await inp('read', { path: 'f.ts', limit: 80 });
  chk('never enlarges a smaller request', e.limit === 80, JSON.stringify(e));
  const f = await inp('anchor_grep', { pattern: 'x', limit: 500 });
  chk('removed tool is left alone (no cap, no crash)', f.limit === 500, JSON.stringify(f));
  const g = await inp('ffgrep', { pattern: 'x', limit: 500 });
  chk('removed ffgrep left alone', g.limit === 500, JSON.stringify(g));
}
console.log('=== 10. ls is active now (defaultTools +ls) and is capped ===');
{
  const a = await inp('ls', { path: 'src' });
  chk('ls default (500) lowered to 100', a.limit === 100, JSON.stringify(a));
  const b = await inp('ls', { path: '.', limit: 500 });
  chk('ls limit capped to 100', b.limit === 100, JSON.stringify(b));
  const c = await inp('ls', { path: '.', limit: 20 });
  chk('ls never enlarges a smaller request', c.limit === 20, JSON.stringify(c));
  const raw = Array.from({ length: 600 }, (_, i) => `entry-${String(i).padStart(3, '0')}/`).join('\n');
  const got = await out('ls', raw);
  chk('oversized ls clamped', got.length < raw.length && got.length < 6000, `in=${raw.length} out=${got.length}`);
  chk('ls head survives', got.includes('entry-000/'));
  chk('ls tail survives', got.includes('entry-599/'));
  const small = await out('ls', 'src/\ntests/');
  chk('normal ls untouched', small === 'src/\ntests/');
}
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} pass / ${fail} fail`);
