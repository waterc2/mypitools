import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from './core.ts';
import { isReviewPrompt, CLEAN_REVIEW } from './testCompletion.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createJiti } = require('/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti');
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': '/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
} });
const { default: install } = await jiti.import('../../extensions/compaction-model.ts');
const model = { provider: 'mytoken', id: 'gpt-6-luna', contextWindow: 262144, maxTokens: 32768, reasoning: true };
function setup(responseMode = 'stop', configured = true, overrides = {}) {
  const handlers = {}, calls = [], audit = [];
  const pi = { on: (event, fn) => { handlers[event] = fn; }, registerCommand() {},
    appendEntry: (type, data) => audit.push({ type, data }), getSettings: () => ({}) };
  install(pi, { config: () => ({ ...DEFAULTS, ...overrides }) });
  const source = [
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Review only. Do not edit source.', timestamp: 1 } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Retained recent progress.' }], timestamp: 2 } },
  ];
  const ctx = { hasUI: false, model: { ...model, id: 'Local', contextWindow: 163840 },
    sessionManager: { getSessionId: () => 'isolated-test', getBranch: () => source },
    modelRegistry: { find: () => configured ? model : undefined, streamSimple: (_model, context, options) => {
      calls.push({ context, options });
      return { result: async () => ({ role: 'assistant', provider: 'mytoken', model: 'gpt-6-luna', stopReason: responseMode,
        content: responseMode === 'toolUse' ? [{ type: 'toolCall', name: 'bash', arguments: { command: 'unsafe' } }] : [{ type: 'text', text: isReviewPrompt(context) ? CLEAN_REVIEW : '## Goal and binding user constraints\nRead-only review.\n## Verification ledger\nNo additional checks executed.' }],
        usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 3 }) };
    } } };
  const controller = new AbortController();
  const event = { branchEntries: source, signal: controller.signal, reason: 'threshold', willRetry: false,
    preparation: { firstKeptEntryId: 'a1', messagesToSummarize: [source[0].message], turnPrefixMessages: [],
      tokensBefore: 150000, isSplitTurn: false, fileOps: { read: new Set(['src/a.ts']), edited: new Set(), written: new Set() } } };
  return { handlers, ctx, event, calls, audit, controller };
}
test('installed extension returns high-fidelity compaction and preserves boundary/main model', async () => {
  const h = setup(); const out = await h.handlers.session_before_compact(h.event, h.ctx);
  assert.equal(out.compaction.firstKeptEntryId, 'a1'); assert.equal(h.ctx.model.id, 'Local');
  assert.equal(out.compaction.details.highFidelity.requestedModel, 'mytoken/gpt-6-luna');
  assert.equal(out.compaction.details.highFidelity.fallback, false);
  assert.equal(out.compaction.details.highFidelity.calls, h.calls.length);
  assert.equal(out.compaction.usage.totalTokens, h.calls.length * 140);
  assert.ok(h.calls.every(c => c.options.toolChoice === 'none' && c.options.cacheRetention === 'none'));
  assert.deepEqual(out.compaction.details.readFiles, ['src/a.ts']);
});
test('length/tool-call outputs never become checkpoints; failure is audited and cancelled', async () => {
  for (const reason of ['length', 'toolUse', 'error']) {
    const h = setup(reason); const out = await h.handlers.session_before_compact(h.event, h.ctx);
    assert.deepEqual(out, { cancel: true }); assert.ok(h.audit.some(a => a.type === 'high-fidelity-compaction-failure'));
  }
});
test('missing model cancels with auditable failure instead of silent low-fidelity fallback', async () => {
  const h = setup('stop', false); assert.deepEqual(await h.handlers.session_before_compact(h.event, h.ctx), { cancel: true });
  assert.equal(h.calls.length, 0); assert.match(h.audit.at(-1).data.reason, /not found/);
});
test('native fallback is explicit and audited, never mistaken for high fidelity', async () => {
  const h = setup('stop', false, { fallback: 'native' });
  assert.equal(await h.handlers.session_before_compact(h.event, h.ctx), undefined);
  assert.equal(h.audit.at(-1).data.fallback, true);
});
test('abort does not issue nested calls or replace history', async () => {
  const h = setup(); h.controller.abort();
  assert.deepEqual(await h.handlers.session_before_compact(h.event, h.ctx), { cancel: true }); assert.equal(h.calls.length, 0);
});
test('split-turn uses same detailed schema and carries previous checkpoint', async () => {
  const h = setup(); h.event.preparation.isSplitTurn = true;
  h.event.preparation.turnPrefixMessages = [{ role: 'assistant', content: [{ type: 'text', text: 'New evidence supersedes candidate R1.' }] }];
  h.event.preparation.previousSummary = 'R1 UNRESOLVED; preserve until later evidence.';
  const out = await h.handlers.session_before_compact(h.event, h.ctx);
  assert.equal(out.compaction.details.highFidelity.splitTurn, true);
  assert.ok(h.calls.some(c => c.context.messages[0].content[0].text.includes('New evidence supersedes')));
  assert.ok(h.calls.some(c => c.context.messages[0].content[0].text.includes('R1 UNRESOLVED')));
});
