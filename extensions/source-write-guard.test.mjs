// Isolated policy tests: no command under test is ever executed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import guard, { guardReason, commandReason } from './source-write-guard.ts';

test('blocks Python, shell writes, inline interpreters and obvious escapes', () => {
  for (const command of [
    "cd /repo && python3 - <<'EOF'\nopen('test.ts','w').write('x')\nEOF",
    '/usr/bin/python3.12 -c "print(1)"', 'uv run python script.py',
    '"/usr/bin/python3" script.py', "'python3' script.py",
    'env PYTHONPATH=/tmp python3 script.py', 'npm test && python3 script.py',
    "cat > src/probe.ts <<'EOF'\nx\nEOF", 'echo x >> src/a.ts',
    'echo x > "src/a.ts"', 'echo x 2> errors.log', 'echo x &> out.log',
    'tee src/a.ts', 'sed -i s/a/b/ src/a.ts', "node -e 'require(\"fs\").writeFileSync(\"a\",\"x\")'",
    'ruby -e "puts 1"', 'bash -lc "echo x"', 'cp a.ts b.ts', 'touch a.ts',
    "awk 'BEGIN {print 1}'", 'echo $(dangerous)', 'echo `dangerous`',
  ]) assert.ok(commandReason(command), command);
});

test('permits ordinary build/tests, stderr merge, quoted comparisons and disposal', () => {
  for (const command of [
    'cd /repo && npx vitest run src/__tests__/windowEscapeStack.test.tsx --reporter=verbose 2>&1 | sed -n 3,20p',
    'npm run build', 'git diff --check', 'git status --short',
    "npx vitest run one.test.ts -t 'a > b'", 'npm test > /dev/null 2>&1',
    'npm test 2>/dev/null', 'npm test &>/dev/null',
  ]) assert.equal(commandReason(command), undefined, command);
});

test('does not mistake quoted search data for Python execution across shell entry points', () => {
  const command = `curl --output /tmp/search.json --request POST https://api.exa.ai/search --data '{"query":"Official Python documentation explaining what is new in Python 3.14"}'`;
  for (const input of [command, `echo "Python 3.14"`, `curl 'https://example.com/python/docs'`]) {
    assert.equal(commandReason(input), undefined, input);
  }
  assert.equal(guardReason('bash', { command }), undefined);
  assert.equal(guardReason('ctx_execute', { language: 'shell', code: command }), undefined);
  assert.equal(guardReason('ctx_batch_execute', { commands: [{ command }] }), undefined);
  // Quoted data must not suppress other policy checks or executable segments.
  assert.ok(commandReason(`${command} && python3 script.py`));
  assert.ok(commandReason(`${command} > src/result.ts`));
  assert.ok(commandReason(`curl --data '{"query":"Python"}' && touch src/result.ts`));
});

test('covers context-mode shell, batch and interpreter entry points', () => {
  for (const name of ['ctx_execute', 'ctx_execute_file', 'mcp__context_mode__ctx_execute']) {
    assert.ok(guardReason(name, { language: 'python', code: 'print(1)' }));
    assert.ok(guardReason(name, { language: 'shell', code: 'echo x > a.ts' }));
    assert.ok(guardReason(name, { language: 'javascript', code: "fs.writeFileSync('a.ts', 'x')" }));
    assert.equal(guardReason(name, { language: 'javascript', code: 'console.log(1 + 1)' }), undefined);
  }
  assert.ok(guardReason('ctx_batch_execute', { commands: [{ command: 'npm run build' }, { command: 'python3 x.py' }] }));
  assert.equal(guardReason('ctx_batch_execute', { commands: [{ command: 'npm run build' }] }), undefined);
  assert.ok(guardReason('ctx_execute', {}));
  assert.ok(guardReason('ctx_batch_execute', { commands: [{}] }));
});

test('permits routed edit/write and blocks raw codemode process/write escapes', () => {
  assert.equal(guardReason('edit', { path: 'a.ts', edits: [] }), undefined);
  assert.equal(guardReason('write', { path: 'a.py', content: 'python' }), undefined);
  assert.equal(guardReason('codemode', { code: "await tools.write({path: 'a.ts', content: 'x'})" }), undefined);
  assert.ok(guardReason('codemode', { code: "fs.writeFileSync('a.ts', 'x')" }));
  assert.ok(guardReason('codemode', { code: "execSync('anything')" }));
});

test('registers an execution-time gate, returning block rather than a post-result warning', async () => {
  const handlers = new Map();
  guard({ on: (event, handler) => handlers.set(event, handler) });
  assert.deepEqual([...handlers.keys()], ['tool_call']);
  const result = await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'python3 x.py' } });
  assert.equal(result.block, true);
  assert.match(result.reason, /Blocked before execution/);
  assert.equal(await handlers.get('tool_call')({ toolName: 'bash', input: { command: 'npm run build' } }), undefined);
});
