import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, plan, serialize, tokens } from './core.ts';
import { checkpointWithCleanReviews as checkpoint } from './testCompletion.mjs';
import { allocatePartBudget, criticalRecords, detailTarget, explicitReports, protectedMemory,
  reportConflicts, sourceRecords } from './preservation.ts';

const answer = text => ({ text: `## Goal and binding user constraints\n${text}\n## Verification ledger\nNo new checks executed.` });
function fixture(messages, overrides = {}) {
  const config = { ...DEFAULTS, maxOutputTokens: 8192 };
  return { records: serialize(messages, config), config,
    plan: plan(30000, 2000, 100000, { contextWindow: 40000, maxTokens: 8192 }, config),
    signal: new AbortController().signal, ...overrides };
}
function memoryLines(summary) {
  const block = summary.split('<!-- hf-memory:v1 -->')[1]?.split('<!-- /hf-memory -->')[0] ?? '';
  return block.trim() ? block.trim().split('\n').map(JSON.parse) : [];
}

test('weighted allocation preserves each part minimum and rolls unused capacity forward', () => {
  const weights = [4, 1, 3], total = 12000;
  const first = allocatePartBudget(total, weights, 0, 8192);
  const log = allocatePartBudget(total, [1, 4, 3], 0, 8192);
  assert.ok(first > log);
  assert.ok(first <= total - 2 * 256);
  assert.equal(allocatePartBudget(3000, weights, 2, 8192), 3000);
  assert.equal(allocatePartBudget(3000, [1], 0, 1024), 1024);
  assert.throws(() => allocatePartBudget(767, weights, 0, 8192), /safe summary budget/);
});
test('detail target adapts to observed host text, not unrelated provider token usage', () => {
  assert.ok(detailTarget(10000, [], false) > 6500);
  assert.ok(detailTarget(10000, [1.8], false) < detailTarget(10000, [], false));
  assert.ok(detailTarget(10000, [0.3], false) > detailTarget(10000, [], false));
  assert.ok(detailTarget(10000, [0.1], false) <= 9200);
  assert.ok(detailTarget(10000, [0.1], true) <= 4000);
});
test('only visible prose contributes critical records; fenced code and working notes are not reports', () => {
  const records = serialize([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'R1 CONFIRMED: unsupported guess.' },
      { type: 'text', text: 'R2 RULED OUT: file.ts:32.\n```ts\nR3 CONFIRMED\n```\n> R4 CONFIRMED\n    R5 CONFIRMED' }] },
    { role: 'toolResult', content: 'R6 CONFIRMED: output is not a candidate ledger.' },
  ], DEFAULTS);
  assert.deepEqual(records[0].critical.map(r => r.key), ['R2']);
  assert.deepEqual(records[1].critical, []);
  assert.deepEqual(explicitReports('R1 might be confirmed.\nnot R2 CONFIRMED\nCHECK[npm test a.test.ts]: FAIL', 'source').map(r => [r.key, r.status]), [['CHECK[npm test a.test.ts]', 'FAIL']]);
});
test('exact user constraints and next actions survive model omissions with sources and explicit limits', async () => {
  const input = fixture([{ role: 'user', content: '只审查，不修改源代码。\n下一步：核对 a.ts:42 的失败断言。' }]);
  const result = await checkpoint(input, async () => answer('General progress only.'));
  const records = memoryLines(result.summary);
  assert.ok(records.some(r => r.kind === 'constraint' && r.text === '只审查，不修改源代码。' && r.source === 'message-1 user'));
  assert.ok(records.some(r => r.kind === 'next-action' && r.text.includes('a.ts:42')));
  assert.match(result.summary, /not newly verified/);
  assert.match(result.audit.preservation.semanticCoverage, /not guaranteed/);
  assert.ok(tokens(result.summary) <= input.plan.summaryBudget);
});
test('protected records deduplicate exact repeated constraints and carry through repeated compactions', async () => {
  const text = 'Do not change compaction trigger rules.';
  const first = await checkpoint(fixture([{ role: 'user', content: text }, { role: 'user', content: text }]), async () => answer('Summary omitted the constraint.'));
  assert.equal(memoryLines(first.summary).filter(r => r.text === text).length, 1);
  assert.ok(first.audit.preservation.duplicates >= 1);
  const second = await checkpoint(fixture([{ role: 'user', content: 'Next: inspect remaining budget.' }], { previousSummary: first.summary }), async () => answer('A new chronological summary.'));
  assert.equal(memoryLines(second.summary).filter(r => r.text === text).length, 1);
  assert.ok(memoryLines(second.summary).some(r => r.source.startsWith('prior checkpoint / ')));
});
test('latest explicit candidate/check reports have stable IDs without claiming semantic reconciliation', async () => {
  const input = fixture([
    { role: 'assistant', content: 'R1 UNRESOLVED: awaiting evidence.\nCHECK[a.test.ts]: FAIL at revision A.' },
    { role: 'user', content: 'R1 RULED OUT: newer evidence in file.ts:32; reopen only if it changes.\nCHECK[a.test.ts]: PASS at revision B.' },
  ]);
  const result = await checkpoint(input, async () => answer('No candidate details.'));
  const records = memoryLines(result.summary);
  assert.equal(records.find(r => r.key === 'R1').status, 'RULED OUT');
  assert.equal(records.find(r => r.key === 'CHECK[a.test.ts]').status, 'PASS');
  assert.equal(records.filter(r => r.key === 'R1').length, 1);
  assert.match(result.summary, /latest explicit REPORT/);
});
test('an explicit candidate/check status inversion gets one bounded integrity rewrite', async () => {
  for (const [source, wrong, correct] of [
    ['R1 RULED OUT: file.ts:32.', 'R1 CONFIRMED: invented.', 'R1 RULED OUT: file.ts:32.'],
    ['CHECK[a.test.ts]: FAIL assertion expected 1, received 0.', 'CHECK[a.test.ts]: PASS', 'CHECK[a.test.ts]: FAIL assertion expected 1, received 0.'],
  ]) {
    const requests = [];
    const result = await checkpoint(fixture([{ role: 'user', content: source }]), async req => {
      requests.push(req); return answer(requests.length === 1 ? wrong : correct);
    });
    assert.equal(requests.length, result.audit.parts + 1);
    assert.equal(result.audit.integrityRewrites, 1);
    assert.equal(result.audit.budgetRewrites, 0);
    assert.equal(result.audit.preservation.detectedConflicts, 1);
    assert.match(requests[1].prompt, /changed an explicit source status/);
    assert.ok(!requests[1].prompt.includes(wrong));
  }
});
test('persistent explicit status inversions cancel and cannot spend calls reserved for later parts', async () => {
  let calls = 0;
  const input = fixture([{ role: 'user', content: 'R1 RULED OUT: established evidence.' }]);
  await assert.rejects(checkpoint(input, async () => { calls += 1; return answer('R1 CONFIRMED: invented.'); }), /conflict after one rewrite/);
  assert.equal(calls, 2);
  input.config.maxCalls = 2; calls = 0;
  await assert.rejects(checkpoint(input, async () => { calls += 1; return answer('R1 CONFIRMED: invented.'); }), /no rewrite capacity/);
  assert.equal(calls, 1);
});
test('tool evidence retains associated command and deduplicates repeated signal lines without fabricating a pass', async () => {
  const input = fixture([
    { role: 'assistant', content: [{ type: 'toolCall', name: 'bash', id: 'check-1', arguments: { command: 'npm run test:target -- a.test.ts' } }] },
    { role: 'toolResult', toolName: 'bash', toolCallId: 'check-1', content: 'FAIL a.test.ts\nFAIL a.test.ts\nAssertionError: expected 1 received 0\nTests 1 failed' },
  ]);
  assert.equal(input.records[1].evidence.split('FAIL a.test.ts').length - 1, 1);
  const result = await checkpoint(input, async () => answer('No verification inventory supplied.'));
  assert.match(result.summary, /npm run test:target -- a.test.ts/);
  assert.match(result.summary, /expected 1 received 0/);
  assert.match(result.summary, /Tests 1 failed/);
  assert.deepEqual(input.records[1].critical, []);
});
test('oversized critical quotes are omitted explicitly, never head-truncated or used to bypass the final budget', async () => {
  const long = 'Do not lose this exact long constraint: ' + '重要约束'.repeat(1500);
  const input = fixture([{ role: 'user', content: long }]);
  const result = await checkpoint(input, async () => answer('Constrained work remains.'));
  assert.ok(result.audit.preservation.omitted > 0);
  assert.ok(!memoryLines(result.summary).some(r => r.text.startsWith('Do not lose')));
  assert.ok(tokens(result.summary) <= input.plan.summaryBudget);
});
test('source report ambiguity is not resolved by regex or claims of complete semantic coverage', () => {
  const records = criticalRecords('user', 'R1 UNRESOLVED: evidence absent.\nR1 CONFIRMED: later report.', 'source');
  const memory = protectedMemory(records, 2000, tokens);
  assert.equal(memory.selected.find(r => r.key === 'R1').status, 'CONFIRMED');
  assert.deepEqual(reportConflicts(records, 'The candidate may be unresolved; not independently verified.'), []);
  assert.match(memory.section, /reused IDs may be ambiguous/);
  assert.equal(sourceRecords([{ label: 'tool' }], '').length, 0);
});
