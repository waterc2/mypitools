// Harness for edit-repair.ts. Runs the guard's tool_call handler on realistic
// inputs, then feeds the (possibly repaired) edits through pi's OWN
// applyEditsToNormalizedContent to prove the repair makes the real edit succeed.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXT = '/home/brady/.pi/agent/extensions/edit-repair.ts';
const PI_DIFF = '/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit-diff.js';

const mod = await import(pathToFileURL(EXT).href);
const ext = mod.default;
const { normalizeToLF, applyEditsToNormalizedContent } = await import(pathToFileURL(PI_DIFF).href);

const handlers = {};
const pi = { on: (name, fn) => { (handlers[name] ||= []).push(fn); } };
ext(pi);

const dir = mkdtempSync(join(tmpdir(), 'edit-repair-'));
const file = (name, content) => { writeFileSync(join(dir, name), content); return name; };

let pass = 0, fail = 0;
const chk = (name, cond, info = '') => {
  if (cond) { pass++; console.log(`  PASS ${name} ${info}`); }
  else { fail++; console.log(`  FAIL ${name} ${info}`); }
};

async function guard(path, edits) {
  const event = { type: 'tool_call', toolName: 'edit', toolCallId: 'x', input: { path, edits } };
  for (const h of handlers.tool_call) {
    const r = await h(event, { cwd: dir });
    if (r) return { blocked: r, input: event.input };
  }
  return { blocked: null, input: event.input };
}

// Apply exactly like pi would (LF-normalized, BOM-stripped content).
function piApply(path, edits) {
  const content = normalizeToLF(readFileSync(join(dir, path), 'utf-8').replace(/^\uFEFF/, ''));
  return applyEditsToNormalizedContent(content, edits, path);
}

console.log('=== 1. exact match: untouched, pi applies ===');
{
  file('a.txt', 'alpha\nbeta\ngamma\n');
  const { blocked, input } = await guard('a.txt', [{ oldText: 'beta', newText: 'BETA' }]);
  chk('not blocked', !blocked);
  chk('untouched', input.edits[0].oldText === 'beta');
  chk('pi applies', piApply('a.txt', input.edits).newContent === 'alpha\nBETA\ngamma\n');
}

console.log('=== 2. indentation: model 2 spaces, file 4 spaces (nested) ===');
{
  const original = ['function f(x) {', '    if (x) {', '        return 1;', '    }', '    return 2;', '}', ''].join('\n');
  file('b.ts', original);
  const edits = [{ oldText: '  if (x) {\n    return 1;\n  }', newText: '  if (x) {\n    return 42;\n  }' }];
  const { blocked, input } = await guard('b.ts', edits);
  chk('not blocked (repaired)', !blocked, blocked?.reason);
  chk('oldText rewritten to file bytes', input.edits[0].oldText === '    if (x) {\n        return 1;\n    }', JSON.stringify(input.edits[0].oldText));
  const applied = piApply('b.ts', input.edits);
  chk('pi applies cleanly', applied.newContent.includes('return 42;'), applied.newContent);
  chk('indentation preserved (4/8 spaces)', applied.newContent.includes('\n    if (x) {\n        return 42;\n    }\n'), JSON.stringify(applied.newContent));
}

console.log('=== 3. indentation: model spaces, file tabs ===');
{
  file('c.ts', 'const o = {\n\tcolor: red,\n\twidth: 10,\n};\n');
  const edits = [{ oldText: '  color: red,\n  width: 10,', newText: '  color: blue,\n  width: 20,' }];
  const { blocked, input } = await guard('c.ts', edits);
  chk('not blocked', !blocked, blocked?.reason);
  const applied = piApply('c.ts', input.edits);
  chk('tabs restored', applied.newContent.includes('\tcolor: blue,\n\twidth: 20,'), JSON.stringify(applied.newContent));
}

console.log('=== 4. multi-edit batch: one sub-edit indent-wrong, batch survives ===');
{
  file('d.ts', 'const a = 1;\nfunction g() {\n    const b = 2;\n    return b;\n}\n');
  const edits = [
    { oldText: 'const a = 1;', newText: 'const a = 100;' },
    { oldText: '  const b = 2;', newText: '  const b = 200;' }, // wrong indent (should be 4)
  ];
  const { blocked, input } = await guard('d.ts', edits);
  chk('not blocked (batch repaired)', !blocked, blocked?.reason);
  const applied = piApply('d.ts', input.edits);
  chk('both edits applied', applied.newContent.includes('const a = 100;') && applied.newContent.includes('    const b = 200;'), JSON.stringify(applied.newContent));
}

console.log('=== 5. not-found: block with verbatim closest region ===');
{
  file('e.ts', 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n');
  const { blocked } = await guard('e.ts', [{ oldText: 'export function greet(nom: string) {\n  return `hello`;\n}', newText: 'x' }]);
  chk('blocked', !!blocked?.block);
  chk('reports not found', /not found/.test(blocked.reason));
  chk('shows closest region header', blocked.reason.includes('Closest region in the current file'), blocked.reason);
  chk('shows verbatim file line', /return `hi \$\{name\}`;/.test(blocked.reason));
  chk('shows line numbers', /^\s*1\|/m.test(blocked.reason) || /1\|/.test(blocked.reason));
}

console.log('=== 6. duplicate oldText: block with line numbers ===');
{
  file('f.txt', 'same line\nother\nsame line\n');
  const { blocked } = await guard('f.txt', [{ oldText: 'same line', newText: 'changed' }]);
  chk('blocked', !!blocked?.block);
  chk('says matches N places', blocked.reason.includes('matches 2 places'), blocked.reason);
  chk('lists both lines', blocked.reason.includes('lines 1, 3'), blocked.reason);
  chk('exact context advice', blocked.reason.includes('Include more surrounding context so the match is unique'), blocked.reason);
}

console.log('=== 7. no-op edit: block ===');
{
  file('g.txt', 'hello\n');
  const { blocked } = await guard('g.txt', [{ oldText: 'hello', newText: 'hello' }]);
  chk('blocked', !!blocked?.block);
  chk('explains no change', /change nothing/.test(blocked.reason), blocked.reason);
}

console.log('=== 8. empty oldText: block ===');
{
  file('h.txt', 'hello\n');
  const { blocked } = await guard('h.txt', [{ oldText: '', newText: 'x' }]);
  chk('blocked', !!blocked?.block);
  chk('explains empty', /oldText is empty/.test(blocked.reason), blocked.reason);
}

console.log('=== 9. overlapping edits: block ===');
{
  file('i.txt', 'abcdefghij\n');
  const { blocked } = await guard('i.txt', [
    { oldText: 'abcde', newText: 'X' },
    { oldText: 'cdefg', newText: 'Y' },
  ]);
  chk('blocked', !!blocked?.block);
  chk('says overlap', /overlap/.test(blocked.reason), blocked.reason);
}

console.log('=== 10. unicode-quote fuzzy that pi already handles: pass untouched ===');
{
  file('j.txt', 'const s = \u201Chello\u201D;\n');
  const { blocked, input } = await guard('j.txt', [{ oldText: 'const s = "hello";', newText: 'const s = "bye";' }]);
  chk('not blocked (pi fuzz handles it)', !blocked, blocked?.reason);
  chk('untouched', input.edits[0].oldText === 'const s = "hello";');
  const applied = piApply('j.txt', input.edits);
  chk('pi applies fuzzy', applied.newContent.includes('"bye"'), JSON.stringify(applied.newContent));
}

console.log('=== 11. missing file: fail open ===');
{
  const { blocked } = await guard('nope.txt', [{ oldText: 'a', newText: 'b' }]);
  chk('not blocked', !blocked);
}

console.log('=== 12. ambiguous indent match (duplicate lines): no silent repair ===');
{
  file('k.ts', 'function a() {\n    return 1;\n}\nfunction b() {\n    return 1;\n}\n');
  const { blocked, input } = await guard('k.ts', [{ oldText: '  return 1;\n}', newText: '  return 2;\n}' }]);
  // "return 1;\n}" appears twice -> indent repair ambiguous; must not rewrite oldText.
  chk('did not silently rewrite', input.edits[0].oldText === '  return 1;\n}', JSON.stringify(input.edits[0].oldText));
  chk('blocked with diagnosis or duplicate', !!blocked?.block, JSON.stringify(blocked?.reason || 'allowed'));
}

console.log('=== 13. unrelated tool untouched ===');
{
  const event = { type: 'tool_call', toolName: 'bash', toolCallId: 'x', input: { command: 'ls' } };
  let r;
  for (const h of handlers.tool_call) r = (await h(event, { cwd: dir })) ?? r;
  chk('bash not blocked', !r?.block);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
