import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULTS, plan, serialize, tokens } from './core.ts';
import { checkpointWithCleanReviews as checkpoint, isReviewPrompt, CLEAN_REVIEW } from './testCompletion.mjs';
import { balancedParts, replaySources, sourceSupplement } from './retention.ts';
const answer = text => ({ text: `## Goal and binding user constraints\n${text}\n## Verification ledger\nNo new checks executed.` });
const factText = n => Array.from({ length: n }, (_, i) => `Fact ${i}: file-${i}.ts:${i + 1} has a distinct observed boundary, assertion and pending action, which are historical evidence only.\n`).join('');
function fixture(messages, configOverrides = {}) {
  const config = { ...DEFAULTS, maxOutputTokens: 8192, ...configOverrides };
  return { records: serialize(messages, config), config,
    plan: plan(30000, 2000, 100000, { contextWindow: 40000, maxTokens: 8192 }, config),
    signal: new AbortController().signal };
}
function fragments(summary) {
  const block = summary.split('<!-- hf-source:v1 -->')[1]?.split('<!-- /hf-source -->')[0] ?? '';
  return block.trim() ? block.trim().split('\n').map(JSON.parse) : [];
}
test('a near-full source and tiny tail use one input when their actual joined size fits', () => {
  const records = [
    { label: 'large', text: 'a'.repeat(29000) },
    { label: 'tail', text: 'TAIL_SOURCE ' + 'b'.repeat(950) },
  ];
  const budget = tokens(records.map(r => r.text).join('\n\n')) + 1;
  const parts = balancedParts(records, budget, 1, tokens);
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /TAIL_SOURCE/);
  assert.ok(tokens(parts[0].text) <= budget);
});
test('required multi-part inputs are balanced and preserve every unique chronological source', () => {
  const source = factText(300);
  const parts = balancedParts([{ label: 'evidence', text: source }], 7000, 3, tokens);
  assert.ok(parts.length >= 3);
  const sizes = parts.map(p => tokens(p.text));
  assert.ok(Math.min(...sizes) / Math.max(...sizes) > 0.6, JSON.stringify(sizes));
  for (const marker of ['Fact 0:', 'Fact 150:', 'Fact 299:']) assert.ok(parts.some(p => p.text.includes(marker)), marker);
  assert.ok(sizes.every(n => n <= 7000));
});
test('short model summaries are supplemented toward target without more model calls or invented text', async () => {
  const input = fixture([{ role: 'user', content: factText(550) }]);
  let calls = 0;
  const result = await checkpoint(input, async () => { calls += 1; return answer('Only a short structured checkpoint.'); });
  assert.equal(calls, result.audit.parts);
  assert.equal(result.audit.version, 6);
  assert.ok(result.audit.retention.floorMet);
  assert.ok(result.audit.retention.ratio >= 0.4 && result.audit.retention.ratio <= 0.7);
  assert.ok(result.audit.retention.targetMet);
  assert.ok(result.audit.retention.sourceSupplement.fragments > 0);
  assert.ok(tokens(result.summary) <= input.plan.summaryBudget);
  for (const fragment of fragments(result.summary)) {
    const original = input.records.find(r => r.label === fragment.source).replayText;
    assert.equal(original.slice(fragment.start, fragment.end), fragment.text);
  }
});
test('supplements exclude private working notes, image bytes and provider signatures', async () => {
  const input = fixture([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_WORKING_NOTES_SHOULD_NOT_BE_REPLAYED '.repeat(50), thinkingSignature: 'OPAQUE_SIGNATURE' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'inspect-only' } }, { type: 'image', data: 'SECRET_IMAGE_BASE64' }] },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: factText(550) },
  ]);
  const result = await checkpoint(input, async () => answer('Historical command output observed.'));
  assert.ok(!result.summary.includes('PRIVATE_WORKING_NOTES_SHOULD_NOT_BE_REPLAYED'));
  assert.ok(!result.summary.includes('SECRET_IMAGE_BASE64'));
  assert.ok(!result.summary.includes('OPAQUE_SIGNATURE'));
  assert.ok(result.audit.retention.sourceSupplement.fragments > 0);
});
test('duplicate log lines cannot pad the minimum; shortfall is explicitly reported', async () => {
  const input = fixture([{ role: 'toolResult', content: 'Repeated ordinary log with no unique evidence or outcome.\n'.repeat(2000) }]);
  const result = await checkpoint(input, async () => answer('Repeated output only.'));
  assert.equal(result.audit.retention.floorMet, false);
  assert.match(result.audit.retention.shortfallReason, /insufficient distinct source/);
  assert.ok(result.audit.retention.sourceSupplement.duplicateLines > 100);
  assert.ok(result.summary.split('Repeated ordinary log with no unique evidence or outcome.').length <= 3);
});
test('Unicode source fragments are valid bounded substrings and carry partial markers', () => {
  const text = '😀中文原始证据'.repeat(1000);
  const supplement = sourceSupplement([{ label: 'unicode', text, priority: 4 }], '', 2100, tokens);
  assert.ok(supplement.tokens <= 2100);
  const parts = fragments(supplement.section);
  assert.ok(parts.length > 0);
  assert.ok(parts.some(p => p.partial));
  for (const p of parts) {
    assert.equal(p.text.isWellFormed(), true);
    assert.equal(text.slice(p.start, p.end), p.text);
  }
});
test('source-backed records survive successive checkpoints without nested JSON escaping growth', async () => {
  const input = fixture([{ role: 'user', content: factText(550) }]);
  const first = await checkpoint(input, async () => answer('Short checkpoint.'));
  const restored = replaySources(first.summary, []);
  assert.ok(restored.some(r => r.label.startsWith('prior / message-')));
  assert.ok(restored.every(r => !r.text.includes('<!-- hf-source:v1 -->')));
  const second = await checkpoint({ ...input, records: [], previousSummary: first.summary }, async () => answer('Another short checkpoint.'));
  assert.ok(second.audit.retention.sourceSupplement.fragments > 0);
  assert.ok(fragments(second.summary).every(p => !p.text.includes('\\"source\\"')));
  assert.ok(tokens(second.summary) <= input.plan.summaryBudget);
});
test('continuation safety overrides retention minimum without exceeding hard context budget', async () => {
  const config = { ...DEFAULTS };
  const input = fixture([{ role: 'user', content: factText(550) }]);
  input.plan = plan(300000, 20000, 100000, { contextWindow: 40000, maxTokens: 8192 }, config);
  const result = await checkpoint(input, async () => answer('Short summary.'));
  assert.equal(result.audit.retention.floorMet, false);
  assert.match(result.audit.retention.shortfallReason, /headroom/);
  assert.ok(result.audit.retention.afterTokens <= input.plan.hardAfterTokens);
});

const require = createRequire(import.meta.url);
const { createJiti } = require('/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': '/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
} });
const { default: install } = await jiti.import('../../extensions/compaction-model.ts');
const model = { provider: 'test', id: 'main', contextWindow: 200000, maxTokens: 8192 };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function extensionFixture() {
  const handlers = {}, appended = [];
  install({ on: (name, fn) => { handlers[name] = fn; }, registerCommand() {}, getSettings: () => ({}),
    appendEntry: (customType, data) => { appended.push({ customType, data }); } }, { config: () => ({ ...DEFAULTS, model: 'test/summary' }) });
  const branch = [
    { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: factText(550), timestamp: 1 } },
    { type: 'message', id: 'kept', parentId: 'user', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', provider: 'test', model: 'main', stopReason: 'stop',
      content: [{ type: 'text', text: 'Recent retained state.' }], timestamp: 2,
      usage: { input: 12000, cacheRead: 18000, cacheWrite: 0, output: 100, totalTokens: 30100, cost: zeroCost } } },
  ];
  const ctx = { hasUI: false, model, sessionManager: { getBranch: () => branch }, modelRegistry: {
    find: () => ({ ...model, id: 'summary' }), streamSimple: (_model, context) => ({ result: async () => ({ role: 'assistant', provider: 'test', model: 'summary',
      stopReason: 'stop', content: [{ type: 'text', text: isReviewPrompt(context) ? CLEAN_REVIEW : answer('Short checkpoint.').text }],
      usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 20, cost: zeroCost } }) }),
  } };
  const event = { branchEntries: branch, signal: new AbortController().signal, reason: 'manual',
    preparation: { firstKeptEntryId: 'kept', tokensBefore: 20000, messagesToSummarize: [branch[0].message], turnPrefixMessages: [],
      fileOps: { read: new Set(), edited: new Set(), written: new Set() } } };
  return { handlers, appended, branch, ctx, event };
}
test('full projection accounting uses the same estimator before and after; provider ratios are separate telemetry', async () => {
  const h = extensionFixture();
  const { compaction } = await h.handlers.session_before_compact(h.event, h.ctx);
  const audit = compaction.details.highFidelity;
  assert.equal(audit.version, 6);
  assert.equal(audit.retention.beforeTokens, audit.projectionEstimateBefore);
  assert.equal(audit.estimatedRetention, audit.retention.ratio);
  assert.equal(audit.observedInputBefore, 30000);
  h.branch.push({ ...compaction, type: 'compaction', id: 'cmp', parentId: 'kept', timestamp: '2026-01-01T00:00:02Z' });
  const message = { role: 'assistant', provider: 'test', model: 'main', stopReason: 'stop', timestamp: Date.parse('2026-01-01T00:00:04Z'),
    usage: { input: 6000, cacheRead: 9000, cacheWrite: 0, output: 200, totalTokens: 15200, cost: zeroCost }, content: [] };
  await h.handlers.message_end({ message }, h.ctx);
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].customType, 'high-fidelity-retention-observed');
  assert.equal(h.appended[0].data.inputAfter, 15000);
  assert.equal(h.appended[0].data.observedRatio, 0.5);
  h.branch.push({ type: 'custom', id: 'observed', parentId: 'cmp', ...h.appended[0] });
  await h.handlers.message_end({ message }, h.ctx);
  assert.equal(h.appended.length, 1);
});
test('Pi preparation upper-bound baselines are labelled rather than claimed as tokenizer measurements', async () => {
  const h = extensionFixture();
  h.event.preparation.tokensBefore = 100000;
  const { compaction } = await h.handlers.session_before_compact(h.event, h.ctx);
  const audit = compaction.details.highFidelity;
  assert.equal(audit.retention.beforeTokens, 100000);
  assert.equal(audit.planningBasis, 'Pi preparation upper-bound baseline');
  assert.ok(audit.projectionEstimateBefore < audit.retention.beforeTokens);
});
test('retention observer ignores unrelated models, old responses, failures and zero usage without affecting triggers', async () => {
  const h = extensionFixture();
  const { compaction } = await h.handlers.session_before_compact(h.event, h.ctx);
  h.branch.push({ ...compaction, type: 'compaction', id: 'cmp', parentId: 'kept', timestamp: '2026-01-01T00:00:02Z' });
  const message = { role: 'assistant', provider: 'test', model: 'main', stopReason: 'stop', timestamp: Date.parse('2026-01-01T00:00:04Z'),
    usage: { input: 6000, cacheRead: 9000, cacheWrite: 0 }, content: [] };
  for (const patch of [{ model: 'other' }, { timestamp: 1 }, { stopReason: 'error' }, { usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }]) {
    await h.handlers.message_end({ message: { ...message, ...patch } }, h.ctx);
  }
  assert.equal(h.appended.length, 0);
  assert.deepEqual(Object.keys(h.handlers).sort(), ['message_end', 'session_before_compact', 'session_before_tree']);
});
