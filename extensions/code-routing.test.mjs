// PURPOSE: focused checks for context-mode's narrowed file-analysis scope and anchor filtering.
// INPUT: installed Pi bridge and local extensions. MUTATION: disposable test files only.
// DETERMINISM: fixed prompt/deny fixtures; no providers, MCP subprocesses or live game data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import anchorFilter from './context-mode-anchor-filter.ts';

const agent = join(homedir(), '.pi/agent');
const bridgePath = join(agent, 'npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js');
const bridge = readFileSync(bridgePath, 'utf8');

test('file-analysis description is compact and patch sources match the installed bridge', () => {
  const from = bridge.indexOf('    const tools = await client.listTools();');
  const endMarker = 'continue; // denied in tool-deny.json: schema stays out of the prompt AND out of the anchor';
  const to = bridge.indexOf(endMarker, from) + endMarker.length;
  assert.ok(from >= 0 && to > from);
  const block = bridge.slice(from, to).trim();
  const extension = readFileSync(join(agent, 'extensions/context-mode-reapply.ts'), 'utf8');
  assert.equal(extension.match(/const BLOCK = `([\s\S]*?)`\.split/)[1].trim(), block);
  const pythonBlock = execFileSync('python3', ['-c',
    'import ast,sys\nt=ast.parse(open(sys.argv[1]).read())\nprint(next(ast.literal_eval(n.value) for n in t.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=="BLOCK" for x in n.targets)))',
    join(agent, 'reapply-context-mode-whitelist.py')], { encoding: 'utf8' }).trim();
  assert.equal(pythonBlock, block);
  const snippet = bridge.slice(bridge.indexOf('const compactDescription'), bridge.indexOf('    const registered = []', from));
  const describe = new Function(snippet + '\nreturn compactDescription;')();
  const description = describe({ name: 'ctx_execute_file' });
  assert.match(description, /large log or structured data/);
  assert.match(description, /code_\* or read for source/);
  assert.ok(description.length < 400);
  assert.equal(describe({ name: 'ctx_search', description: 'unchanged' }), 'unchanged');
});

test('anchor loses hierarchy/source-read routing, filters denied tools and preserves memory and real messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'routing-anchor-'));
  const saved = process.env.TOOL_DENY_CONFIG;
  process.env.TOOL_DENY_CONFIG = join(dir, 'deny.json');
  writeFileSync(process.env.TOOL_DENY_CONFIG, JSON.stringify({ deny: ['ctx_doctor'] }));
  try {
    const handlers = new Map();
    anchorFilter({ on: (name, handler) => handlers.set(name, handler) });
    const anchor = 'context-mode active. Hierarchy: ctx_batch_execute > ctx_execute_file. Read/edit files → ctx_execute_file. Multi-command research → ctx_batch_execute. Doctor → ctx_doctor.';
    const tail = { role: 'user', content: [{ type: 'text', text: anchor + '\n<active_memory>keep exactly</active_memory>' }] };
    const real = { role: 'user', content: 'Please explain this literal: ' + anchor };
    const tool = { role: 'toolResult', content: anchor };
    const messages = [{ role: 'system', content: 'Rules\n' + anchor }, real, tool, tail];
    const result = await handlers.get('context_with_system')({ messages });
    assert.equal(result.messages[1], real);
    assert.equal(result.messages[2], tool);
    const system = result.messages[0].content;
    const text = result.messages[3].content[0].text;
    for (const value of [system, text]) {
      assert.doesNotMatch(value, /Hierarchy:|Read\/edit files|ctx_doctor|Multi-command research/);
      assert.match(value, /Large logs\/structured data → ctx_execute_file/);
      assert.match(value, /Logs\/build output → ctx_batch_execute/);
    }
    assert.ok(text.endsWith('<active_memory>keep exactly</active_memory>'));
    assert.equal(await handlers.get('context_with_system')({ messages: result.messages }), undefined, 'idempotent rewrite');
    const early = await handlers.get('before_agent_start')({ systemPrompt: 'Rules\n' + anchor });
    assert.doesNotMatch(early.systemPrompt, /Hierarchy:|Read\/edit files/);
    assert.equal(await handlers.get('context_with_system')({ messages: [real] }), undefined, 'system-first gate retained');
  } finally {
    if (saved === undefined) delete process.env.TOOL_DENY_CONFIG; else process.env.TOOL_DENY_CONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
