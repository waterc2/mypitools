// PURPOSE: prove the v7 tolerance/condensation policy of the high-fidelity compaction core:
//          (1) a part that still exceeds its ceiling after the rewrite is accepted and audited
//              instead of cancelling the whole checkpoint;
//          (2) a joined summary over budget triggers a condensation call that brings it back
//              under summaryBudget;
//          (3) an invented/flipped explicit report status stays fatal;
//          (4) every generation/condensation prompt carries the English-narrative directive.
// INPUT:   ~/.pi/agent/lib/high-fidelity-compaction/core.ts (loaded through pi's jiti resolver)
// OUTPUT:  exit code 0 = all assertions pass.
// MUTATION: none. Pure in-memory fixtures with a fake Complete callback; no session files,
//           no model calls, no network, no filesystem writes.
// DETERMINISM: fixed budgets, fixed fake outputs; the host token estimator is deterministic.
import { pathToFileURL } from 'node:url';

const PI_ROOT = '/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent';
const { createJiti } = await import(pathToFileURL(`${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`).href);
const jiti = createJiti(import.meta.url, {
	alias: { '@earendil-works/pi-coding-agent': `${PI_ROOT}/dist/index.js` },
});
const core = await jiti.import('/home/brady/.pi/agent/lib/high-fidelity-compaction/core.ts');
const { checkpoint, DEFAULTS, tokens } = core;

let failures = 0;
const check = (ok, label) => {
	if (ok) console.log(`  ok: ${label}`);
	else { failures += 1; console.error(`  FAIL: ${label}`); }
};
const plan = {
	targetAfterTokens: 1100, summaryBudget: 900, inputBudget: 60000, outputPerCall: 8000,
	retainedTokens: 200, requestedRetention: 0.55, limited: false,
	beforeTokens: 2000, floorAfterTokens: 100, hardAfterTokens: 2000,
};
const longPart = `## Completed work and established code facts\n${'Verified fact line with exact identifier CARD-42 and file:line src/logic/battle/state/cardTypes.ts:88. '.repeat(60)}`;
const shortPart = '## Completed work and established code facts\nVerified fact CARD-42 at src/logic/battle/state/cardTypes.ts:88.';

// Scenario 1+4: over-ceiling draft accepted on both attempts, joined summary condensed back under budget.
{
	const prompts = [];
	let call = 0;
	const complete = async request => {
		prompts.push(request.prompt);
		call += 1;
		const condense = request.prompt.includes('Condense one chronological checkpoint part');
		return { text: condense ? shortPart : longPart,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	};
	const records = [{ label: 'message-1 user', text: '[message-1 user]\nUser asked to fix the compaction failure. '.repeat(40), omittedChars: 0, reasoningChars: 0, priority: 4 }];
	const result = await checkpoint({ records, plan, config: { ...DEFAULTS }, signal: new AbortController().signal }, complete);
	check(result.audit.version === 7, 'overrun scenario audits as version 7');
	check(result.audit.budgetOverruns === 1, `over-ceiling part accepted and counted (budgetOverruns=${result.audit.budgetOverruns})`);
	check(result.audit.condensation.calls >= 1, `condensation ran (calls=${result.audit.condensation.calls})`);
	check(tokens(result.summary) <= plan.summaryBudget, `final summary fits budget (${tokens(result.summary)} <= ${plan.summaryBudget})`);
	check(result.audit.calls === 3, `exactly generate+rewrite+condense calls (${result.audit.calls})`);
	check(result.summary.includes('(condensed)'), 'condensed part is labelled in the summary');
	check(prompts.slice(0, 2).every(p => p.includes('Write the narrative in English')), 'generation prompts demand English narrative');
	check(prompts.at(-1).includes('Rewrite the part in English'), 'condensation prompt demands English rewrite');
}

// Scenario 2: invented/flipped explicit report status remains fatal after the rewrite.
{
	// Larger summary budget so fixed card/memory sections cannot starve the part allocation pre-loop.
	const plan2 = { ...plan, summaryBudget: 2000, targetAfterTokens: 2200, hardAfterTokens: 4000 };
	let call = 0;
	const complete = async () => {
		call += 1;
		return { text: '## Candidate/decision ledger\nCandidate R1: RULED OUT — testing.\n', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	};
	const records = [{ label: 'message-1 assistant', text: '[message-1 assistant]\nCandidate R1: CONFIRMED via npm run test:target.', omittedChars: 0, reasoningChars: 0, priority: 3,
		critical: [{ kind: 'candidate', source: 'message-1 assistant', text: 'Candidate R1: CONFIRMED', key: 'R1', status: 'CONFIRMED' }] }];
	let threw = '';
	try { await checkpoint({ records, plan: plan2, config: { ...DEFAULTS }, signal: new AbortController().signal }, complete); }
	catch (error) { threw = error instanceof Error ? error.message : String(error); }
	check(threw.startsWith('Explicit report conflict after one rewrite'), `flipped status stays fatal (${threw})`);
	check(call === 2, `conflict path used exactly the two planned calls (${call})`);
}

// Scenario 3: a malformed coverage-review response degrades to an unreviewed part instead of cancelling.
{
	const complete = async request => {
		if (request.purpose === 'coverage-review') return { text: 'not valid JSON at all', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		return { text: shortPart, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	};
	const records = [{ label: 'message-1 user', text: '[message-1 user]\nUser asked to fix the compaction failure. '.repeat(40), omittedChars: 0, reasoningChars: 0, priority: 4 }];
	const result = await checkpoint({ records, plan, config: { ...DEFAULTS }, signal: new AbortController().signal }, complete);
	check(result.audit.coverage.reviewParseFailures === 1, `malformed review counted, not fatal (reviewParseFailures=${result.audit.coverage.reviewParseFailures})`);
	check(result.audit.calls === 2 && result.audit.parts === 1, `generation plus one review call only (${result.audit.calls})`);
	check(tokens(result.summary) <= plan.summaryBudget, `summary fits budget without condensation (${tokens(result.summary)})`);
}

console.log(failures ? `FAILED: ${failures} assertion(s)` : 'PASSED: high-fidelity-compaction v7 tolerance policy');
process.exit(failures ? 1 : 0);
