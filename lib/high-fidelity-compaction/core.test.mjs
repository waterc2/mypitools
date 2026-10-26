import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS, parseConfig, excerpt, tokens, serialize, plan, addUsage } from './core.ts';
import { checkpointWithCleanReviews as checkpoint } from './testCompletion.mjs';
const cfg = () => ({ ...DEFAULTS });
const signal = () => new AbortController().signal;
const limits = { contextWindow: 262144, maxTokens: 32768 };
const fixture = (overrides = {}) => ({ records: serialize([{ role: 'user', content: '只审查，不修改。' }], cfg()),
  config: cfg(), plan: plan(150000, 24000, 200000, limits, cfg()), signal: signal(), ...overrides });
const answer = text => ({ text: `## Goal and binding user constraints\n${text}\n## Verification ledger\nNo additional execution evidenced.` });

test('config preserves model override, validates ratio and budgets', () => {
  assert.equal(parseConfig({ model: 'proxy/org/model' }).targetRetention, 0.5);
  for (const raw of [{ targetRetention: 0.3 }, { targetRetention: 0.8 }, { maxRetention: 0.4 }, { maxCalls: 0 }, { thinkingLevel: 'fast' }, { maxInputTokens: NaN }]) assert.throws(() => parseConfig(raw));
});
test('head, middle failing assertion and final summary survive; output stays bounded', () => {
  const text = 'COMMAND npm test\n' + 'ok normal log\n'.repeat(2000) + 'FAIL inlayPanel.test.tsx:150\nAssertionError: expected [] to equal [[0,"77"]]\n' + 'padding\n'.repeat(2000) + 'Test Files 1 failed | 10 passed\nTests 1 failed | 136 passed';
  const output = excerpt(text, 16000);
  assert.ok(output.length <= 16000);
  for (const key of ['COMMAND npm test', 'expected []', '136 passed', 'omitted']) assert.ok(output.includes(key), key);
  assert.equal(excerpt('short output', 16000), 'short output');
});
test('a flood of FAIL lines cannot exceed cap or cut the tail', () => {
  const output = excerpt('HEAD\n' + 'FAIL repeated noisy line\n'.repeat(10000) + 'DECISIVE TAIL', 4096);
  assert.ok(output.length <= 4096); assert.ok(output.endsWith('DECISIVE TAIL'));
});
test('working notes are optional, bounded and explicitly unverified; no opaque signatures/images', () => {
  const m = { role: 'assistant', content: [{ type: 'thinking', thinking: 'maybe confirmed\n'.repeat(1000), thinkingSignature: 'DO_NOT_SEND' }, { type: 'toolCall', name: 'bash', id: 'c1', arguments: { command: 'npm test' } }, { type: 'image', data: 'SECRET_BASE64' }] };
  const record = serialize([m], cfg())[0];
  assert.match(record.text, /UNVERIFIED/); assert.match(record.text, /Tool call bash/);
  assert.ok(!record.text.includes('DO_NOT_SEND')); assert.ok(!record.text.includes('SECRET_BASE64'));
  assert.ok(record.omittedChars > 0);
  assert.ok(!serialize([m], { ...cfg(), thinkingMaxChars: 0 })[0].text.includes('maybe confirmed'));
});
test('budget includes retained system/tail and reserves continuation headroom', () => {
  const p = plan(150000, 24000, 163840, limits, cfg());
  assert.equal(p.targetAfterTokens, 75000); assert.equal(p.summaryBudget, 50488);
  assert.ok(p.inputBudget + p.outputPerCall + cfg().inputSafetyTokens <= limits.contextWindow);
  assert.throws(() => plan(10000, 9000, 163840, limits, cfg()), /Kept history/);
  const limited = plan(300000, 20000, 163840, limits, cfg());
  assert.ok(limited.limited); assert.ok(limited.targetAfterTokens <= 163840 - cfg().continuationReserveTokens);
});
test('splits detailed output across model calls, keeps previous checkpoint and operator focus', async () => {
  const prompts = [];
  const input = fixture({ previousSummary: 'RULED OUT R2: evidence in file.ts:32; reopen only after source changes.\n' + 'Established code fact with precise evidence.\n'.repeat(200), customInstructions: '保留失败断言原文。' });
  const result = await checkpoint(input, async req => { prompts.push(req); return answer(`Assigned part examined. ${req.prompt.includes('RULED OUT R2') ? 'RULED OUT R2 retained.' : 'No new issue.'}`); });
  assert.ok(prompts.length >= 2);
  assert.ok(prompts.some(p => p.prompt.includes('RULED OUT R2')));
  assert.ok(prompts.every(p => p.prompt.includes('保留失败断言原文。')));
  assert.ok(prompts.every(p => p.maxTokens <= limits.maxTokens));
  assert.ok(tokens(result.summary) <= input.plan.summaryBudget);
  assert.ok(result.summary.includes('RULED OUT R2 retained'));
  assert.equal(result.audit.requestedRetention, 0.5);
});
test('oversized source is split, not discarded, and request/global budgets hold', async () => {
  const c = { ...cfg(), maxInputTokens: 12000, maxOutputTokens: 4096, maxCalls: 32 };
  const p = plan(30000, 2000, 100000, { contextWindow: 40000, maxTokens: 4096 }, c);
  const input = fixture({ config: c, plan: p, records: [{ label: 'large-record', text: 'first fact\n' + 'code '.repeat(18000) + '\nlast fact', omittedChars: 0, reasoningChars: 0 }] });
  const prompts = [];
  const result = await checkpoint(input, async req => { prompts.push(req.prompt); assert.ok(tokens(req.prompt) <= p.inputBudget); return answer('Bounded part.'); });
  assert.ok(prompts.length > 1); assert.ok(prompts[0].includes('first fact')); assert.ok(prompts.at(-1).includes('last fact'));
  assert.ok(tokens(result.summary) <= p.summaryBudget);
});
test('host evidence preserves a failed assertion even when generated summary misses it', async () => {
  const records = serialize([{ role: 'toolResult', toolName: 'bash', toolCallId: 't1', content: [{ type: 'text', text: 'padding\n'.repeat(500) + 'AssertionError: expected [] to equal [[0,"77"]]\nTests 1 failed | 136 passed' }] }], cfg());
  const result = await checkpoint(fixture({ records }), async () => answer('Only general progress.'));
  assert.match(result.summary, /expected \[\]/); assert.match(result.summary, /136 passed/);
});
test('abort and incomplete output fail without returning a partial checkpoint', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(checkpoint(fixture({ signal: controller.signal }), async () => { called = true; return answer('bad'); }), /aborted/);
  assert.equal(called, false);
  await assert.rejects(checkpoint(fixture(), async () => ({ text: '' })), /Empty/);
  await assert.rejects(checkpoint(fixture(), async () => { throw new Error('provider length'); }), /provider length/);
});
test('resource ceiling cancels rather than silently dropping middle chunks', async () => {
  await assert.rejects(checkpoint(fixture({ config: { ...cfg(), maxCalls: 1 },
    records: [{ label: 'large-state', text: 'Established fact.\n'.repeat(3000), omittedChars: 0, reasoningChars: 0 }] }), async () => answer('not called')), /maxCalls/);
});
test('successive compactions forward prior closed candidates and new corrections without truncating the prior checkpoint', async () => {
  const first = await checkpoint(fixture({ records: serialize([{ role: 'user', content: 'R2 RULED OUT: file.ts:32. Reopen only after source changes.' }], cfg()) }),
    async req => answer(req.prompt.includes('R2 RULED OUT: file.ts:32.') ? 'R2 RULED OUT: file.ts:32. Reopen only after source changes.' : 'Other chronological evidence.'));
  const seen = [];
  const second = await checkpoint(fixture({ previousSummary: first.summary,
    records: serialize([{ role: 'user', content: 'R3 UNRESOLVED: Correction: R3 is unresolved, not confirmed. Preserve read-only authorization.' }], cfg()) }),
    async req => { seen.push(req.prompt); return answer(req.prompt.includes('R2 RULED OUT: file.ts:32.') ? 'R2 RULED OUT: file.ts:32. No edits authorized.' : req.prompt.includes('R3 UNRESOLVED: Correction:') ? 'R3 UNRESOLVED after user correction.' : 'Other chronological evidence.'); });
  assert.ok(seen.some(p => p.includes('R2 RULED OUT: file.ts:32')));
  assert.ok(seen.some(p => p.includes('R3 is unresolved, not confirmed')));
  assert.match(second.summary, /R2 RULED OUT/); assert.match(second.summary, /R3 UNRESOLVED/);
});
test('Unicode-aware estimates and excerpts do not produce broken surrogate pairs', () => {
  assert.ok(tokens('中文'.repeat(100)) > tokens('ab'.repeat(100)));
  for (const cap of [1, 179, 181, 4096]) {
    const value = excerpt('😀'.repeat(5000), cap);
    assert.ok(value.length <= cap);
    assert.equal(value.isWellFormed(), true);
  }
});
test('usage is conserved across calls and cost objects are not mutated', () => {
  const u = { input: 3, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 8, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
  const sum = addUsage(u, u); assert.equal(sum.totalTokens, 16); assert.equal(sum.cost.total, 6); assert.equal(u.cost.total, 3);
});
