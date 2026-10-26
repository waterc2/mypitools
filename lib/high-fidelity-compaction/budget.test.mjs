import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULTS, plan, serialize, tokens } from './core.ts';
import { checkpointWithCleanReviews as checkpoint, isReviewPrompt, CLEAN_REVIEW } from './testCompletion.mjs';

const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } };
const completeText = detail => ({ text: `## Goal and binding user constraints\n${detail}\n## Verification ledger\nNo new checks executed.`, usage, actualModel: 'test/summary' });
const oversized = () => completeText('详细证据'.repeat(1200));
function fixture(overrides = {}) {
  const config = { ...DEFAULTS, maxOutputTokens: 8192 };
  const budget = plan(10000, 488, 100000, { contextWindow: 40000, maxTokens: 8192 }, config);
  return { records: serialize([{ role: 'user', content: 'Read-only. Candidate R1 RULED OUT; reopen only after source changes. Tail evidence: keep this final constraint.' }], config),
    config, plan: budget, signal: new AbortController().signal, ...overrides };
}

test('over-budget Unicode output is rewritten once from original data, never truncated', async () => {
  const requests = [];
  const input = fixture();
  const result = await checkpoint(input, async request => {
    requests.push(request);
    return requests.length === 1 ? oversized() : completeText('Read-only. R1 RULED OUT. Reopen only after source changes. Tail evidence retained.');
  });
  assert.equal(requests.length, 2);
  assert.match(requests[1].prompt, /previous attempt measured/);
  assert.match(requests[1].prompt, /Tail evidence: keep this final constraint/);
  assert.ok(!requests[1].prompt.includes('详细证据'));
  assert.match(requests[0].prompt, /non-ASCII code points \* 2/);
  assert.match(result.summary, /Tail evidence retained/);
  assert.ok(tokens(result.summary) <= input.plan.summaryBudget);
  assert.equal(result.audit.calls, 3);
  assert.equal(result.audit.parts, 1);
  assert.equal(result.audit.budgetRewrites, 1);
  assert.equal(result.usage.totalTokens, 30); // two billed generation fixtures; helper review has no usage
  assert.equal(result.usage.cost.total, 6);
  assert.ok(requests.every(r => tokens(r.prompt) <= input.plan.inputBudget && r.maxTokens <= input.plan.outputPerCall));
});
test('a second oversized result cancels with measured bounds, not an unbounded retry', async () => {
  let calls = 0;
  await assert.rejects(checkpoint(fixture(), async () => { calls += 1; return oversized(); }), /after one rewrite \(\d+ > \d+ estimated tokens; part 1\/1\)/);
  assert.equal(calls, 2);
});
test('maxCalls includes rewrites and leaves a slot for every remaining chronological part', async () => {
  const records = [1, 2].map(i => ({ label: `part-${i}`, text: `${i}: ` + 'x'.repeat(3000), omittedChars: 0, reasoningChars: 0 }));
  const input = fixture();
  input.records = records;
  input.plan.outputPerCall = 4096;
  input.config.maxCalls = 4;
  let calls = 0;
  await assert.rejects(checkpoint(input, async () => { calls += 1; return oversized(); }), /no rewrite capacity within maxCalls=4/);
  assert.equal(calls, 1);

  input.config.maxCalls = 5;
  const requests = [];
  const result = await checkpoint(input, async req => {
    requests.push(req);
    return requests.length === 1 ? oversized() : completeText('All assigned constraints retained.');
  });
  assert.equal(result.audit.calls, 5);
  assert.equal(result.audit.parts, 2);
  assert.equal(result.audit.budgetRewrites, 1);
  assert.match(requests.at(-1).prompt, /Part 2\/2/);
  assert.ok(tokens(result.summary) <= input.plan.summaryBudget);
});
test('abort after an oversized response prevents its rewrite', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(checkpoint(fixture({ signal: controller.signal }), async () => {
    calls += 1; controller.abort(); return oversized();
  }), /aborted/);
  assert.equal(calls, 1);
});
test('a failed or malformed rewrite never becomes a checkpoint', async () => {
  for (const reply of [async () => { throw new Error('provider length'); }, async () => ({ text: 'incomplete' })]) {
    let calls = 0;
    await assert.rejects(checkpoint(fixture(), async () => ++calls === 1 ? oversized() : reply()), /provider length|unstructured/);
    assert.equal(calls, 2);
  }
});

const require = createRequire(import.meta.url);
const { createJiti } = require('/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': '/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
} });
const { default: install } = await jiti.import('../../extensions/compaction-model.ts');
const { buildSessionProjection } = await import('/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
test('summary calls use isolated routing IDs; applying the checkpoint replaces, not appends to, model history', async () => {
  const handlers = {}, calls = [];
  const model = { provider: 'test', id: 'summary', contextWindow: 40000, maxTokens: 8192, reasoning: false };
  const entries = [
    { type: 'message', id: 'old', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'OLD_RAW_HISTORY_ONLY', timestamp: 1 } },
    { type: 'message', id: 'kept', parentId: 'old', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'RECENT_VERBATIM_HISTORY', timestamp: 2 } },
  ];
  install({ on: (name, handler) => { handlers[name] = handler; }, registerCommand() {}, getSettings: () => ({}),
    appendEntry() { assert.fail('Compaction should succeed'); } }, { config: () => ({ ...DEFAULTS, model: 'test/summary' }) });
  const ctx = { hasUI: false, model: { contextWindow: 163840 },
    sessionManager: { getSessionId: () => 'MAIN_SESSION_MUST_NOT_BE_REUSED' },
    modelRegistry: { find: () => model, streamSimple: (_model, context, options) => {
      calls.push({ context, options });
      return { result: async () => ({ role: 'assistant', provider: 'test', model: 'summary', stopReason: 'stop', usage,
        content: [{ type: 'text', text: isReviewPrompt(context) ? CLEAN_REVIEW : completeText('CHECKPOINT_REPLACEMENT_ONLY').text }], timestamp: 3 }) };
    } } };
  const event = { branchEntries: entries, reason: 'manual', signal: new AbortController().signal,
    preparation: { firstKeptEntryId: 'kept', tokensBefore: 30000,
      messagesToSummarize: [entries[0].message, { role: 'user', content: 'Summarized historical evidence.\n'.repeat(1000) }], turnPrefixMessages: [],
      fileOps: { read: new Set(), edited: new Set(), written: new Set() } } };
  const { compaction } = await handlers.session_before_compact(event, ctx);
  assert.ok(compaction);
  assert.ok(calls.length > 1);
  assert.equal(new Set(calls.map(c => c.options.sessionId)).size, calls.length);
  for (const { context, options } of calls) {
    assert.notEqual(options.sessionId, 'MAIN_SESSION_MUST_NOT_BE_REUSED');
    assert.equal(context.messages.length, 1);
    assert.equal(context.messages[0].role, 'user');
    assert.equal(options.cacheRetention, 'none');
    assert.equal(options.toolChoice, 'none');
  }
  const projected = buildSessionProjection([...entries,
    { ...compaction, type: 'compaction', id: 'checkpoint', parentId: 'kept', timestamp: '2026-01-01T00:00:03Z' }]);
  const wire = JSON.stringify(projected.messages);
  assert.match(wire, /CHECKPOINT_REPLACEMENT_ONLY/);
  assert.match(wire, /RECENT_VERBATIM_HISTORY/);
  assert.ok(!wire.includes('OLD_RAW_HISTORY_ONLY'));
  assert.equal(entries[0].message.content, 'OLD_RAW_HISTORY_ONLY');
});
