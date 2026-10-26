// PURPOSE: prove compaction-count.ts renders the compaction count immediately after
//          the context segment of pi's built-in footer stats line (`(auto) ↻N`),
//          without rewriting the footer and without changing the rendered width.
// INPUT:   ~/.pi/agent/extensions/compaction-count.ts
//          pi's real FooterComponent (dist/index.js of the installed pi package)
// OUTPUT:  exit code 0 = all assertions pass.
// MUTATION: none. Renders pi's real FooterComponent against a fake session object;
//           no model calls, no session files, no network.
// DETERMINISM: fixed fixtures and timestamps; no randomness, no clock dependence.
import { pathToFileURL } from 'node:url';

const PI_ROOT = '/home/brady/.nvm/versions/node/v22.23.2/lib/node_modules/@earendil-works/pi-coding-agent';
const TUI_ROOT = `${PI_ROOT}/node_modules/@earendil-works/pi-tui`;
const { FooterComponent, initTheme } = await import(pathToFileURL(`${PI_ROOT}/dist/index.js`).href);
const { visibleWidth } = await import(pathToFileURL(`${TUI_ROOT}/dist/index.js`).href);

// The extension imports pi bare specifiers, so load it through pi's own resolver.
const { createJiti } = await import(pathToFileURL(`${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`).href);
const jiti = createJiti(import.meta.url, {
	alias: {
		'@earendil-works/pi-coding-agent': `${PI_ROOT}/dist/index.js`,
		'@earendil-works/pi-tui': `${TUI_ROOT}/dist/index.js`,
	},
});
const { injectMarker, findFooterComponent } = await jiti.import(
	'/home/brady/.pi/agent/extensions/compaction-count.ts',
);
const mod = { injectMarker, findFooterComponent, default: (await jiti.import('/home/brady/.pi/agent/extensions/compaction-count.ts')).default };

let failures = 0;
const check = (name, cond, extra) => {
	if (!cond) {
		failures += 1;
		console.log(`FAIL ${name}${extra ? ` :: ${extra}` : ''}`);
	} else console.log(`ok   ${name}`);
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

await initTheme('dark');

// --- real FooterComponent over a fake session -----------------------------
const entries = [
	{ type: 'session', id: 's0' },
	{
		type: 'message',
		id: 'm1',
		message: {
			role: 'assistant',
			usage: { input: 405_000, output: 70_000, cacheRead: 13_000_000, cacheWrite: 0, cost: { total: 1.234 } },
		},
	},
	{ type: 'compaction', id: 'c1', tokensBefore: 152_345, timestamp: '2026-01-01T10:00:00Z' },
	{ type: 'compaction', id: 'c2', tokensBefore: 120_000, timestamp: '2026-01-01T11:00:00Z' },
	{ type: 'message', id: 'm2', message: { role: 'user' } },
];
const sessionManager = {
	getEntries: () => entries,
	getEntryCount: () => new Set(entries.map((e) => e.id)).size,
	getSessionId: () => 'sess-test',
	getLeafId: () => 'm2',
	getCwd: () => '/home/brady/code',
	getSessionName: () => undefined,
};
const model = { id: 'glm-4.6', provider: 'zai', contextWindow: 200_000, reasoning: true };
const session = {
	state: { model, thinkingLevel: 'high' },
	model,
	routedModel: undefined,
	modelRuntime: { isUsingSubscription: () => false },
	sessionManager,
	getContextUsage: () => ({ tokens: 78_600, contextWindow: 200_000, percent: 39.3 }),
};
const footerData = {
	getGitBranch: () => 'main',
	getExtensionStatuses: () => new Map([['pi-cache-stats', 'cache 99.1% hit']]),
	getAvailableProviderCount: () => 3,
	onBranchChange: () => () => {},
};

const realFooter = new FooterComponent(session, footerData);

// --- wire the extension against a component tree holding the real footer --
let renderRequests = 0;
const fakeTui = {
	children: [{ children: [{ render: () => [] }, { children: [realFooter] }] }],
	requestRender() {
		renderRequests += 1;
	},
};
const statusCalls = [];
let notifyCalls = [];
let footerFactory;
const ctx = {
	mode: 'tui',
	hasUI: true,
	cwd: '/home/brady/code',
	sessionManager,
	ui: {
		setWidget(_key, content) {
			// pi invokes widget factories synchronously with the TUI instance
			if (typeof content === 'function') content(fakeTui, { fg: () => '' });
		},
		setFooter(factory) {
			footerFactory = factory;
		},
		setStatus(key, text) {
			statusCalls.push([key, text]);
		},
		notify(message, type) {
			notifyCalls.push([message, type]);
		},
	},
};

const handlers = new Map();
const commands = new Map();
mod.default({
	on(event, handler) {
		handlers.set(event, handler);
		return () => {};
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
});

check('registers session_start', handlers.has('session_start'));
check('registers session_compact', handlers.has('session_compact'));
check('registers /compactions', commands.has('compactions'));

handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
check('installs a footer proxy', typeof footerFactory === 'function');
check('probe finds the REAL FooterComponent', findFooterComponent(fakeTui) === realFooter);
check('no fallback status line needed', statusCalls.every(([, text]) => text === undefined));

const theme = { fg: (_color, text) => dim(text) };
const footer = footerFactory(fakeTui, theme);

for (const W of [80, 100, 140, 200]) {
	const before = realFooter.render(W);
	const after = footer.render(W);
	const line = strip(after[1] ?? '');
	check(`W=${W}: marker directly after (auto)`, line.includes('39.3%/200k (auto) \u21bb 2'), line.slice(0, 60));
	check(
		`W=${W}: width unchanged`,
		visibleWidth(before[1]) === visibleWidth(after[1]),
		`${visibleWidth(before[1])} vs ${visibleWidth(after[1])}`,
	);
	check(`W=${W}: no new overflow`, after.every((l) => visibleWidth(l) <= Math.max(W, visibleWidth(before[
		after.indexOf(l)
	] ?? ''))));
	check(`W=${W}: pwd line untouched`, after[0] === before[0]);
	check(`W=${W}: model+provider still right-aligned`, line.trimEnd().endsWith('glm-4.6 \u2022 high') || !line.includes('glm-4.6'));
}

// auto-compaction disabled: pi prints no "(auto)", so the marker follows the ctx segment
realFooter.setAutoCompactEnabled(false);
const noAuto = strip(footer.render(140)[1]);
check('no (auto): marker after ctx segment', noAuto.includes('39.3%/200k \u21bb 2'), noAuto.slice(0, 60));
realFooter.setAutoCompactEnabled(true);

// a new compaction bumps the count and requests a render
entries.push({ type: 'compaction', id: 'c3', tokensBefore: 99_000, timestamp: '2026-01-01T12:00:00Z' });
handlers.get('session_compact')({ type: 'session_compact', reason: 'threshold' }, ctx);
check('session_compact requests a render', renderRequests > 0);
check('count becomes 3', strip(footer.render(140)[1]).includes('(auto) \u21bb 3'));

// /compactions report
notifyCalls = [];
await commands.get('compactions').handler('', ctx);
const report = notifyCalls.at(-1)?.[0] ?? '';
check('report states the count', report.includes('Context compactions in this session: 3'), report);
check('report lists tokensBefore', report.includes('152k tokens') && report.includes('99k tokens'));

// hide / show
await commands.get('compactions').handler('hide', ctx);
check('hide removes the marker', !strip(footer.render(140)[1]).includes('\u21bb'));
await commands.get('compactions').handler('show', ctx);
check('show restores the marker', strip(footer.render(140)[1]).includes('(auto) \u21bb 3'));

// disposing the proxy must not dispose pi's footer
footer.dispose();
check('proxy dispose leaves built-in footer usable', realFooter.render(140).length > 0);

// pure injectMarker edge cases
check('narrow line gets truncated, not widened', visibleWidth(injectMarker('a 9.9%/200k (auto) model', ' \u21bb 2', ' \u21bb 2')) === visibleWidth('a 9.9%/200k (auto) model'));
check('unknown layout left untouched (never mangled)', injectMarker('plain stats', ' \u21bb 7', ' \u21bb 7') === 'plain stats');
check(
	'unknown layout with trailing padding absorbs it',
	strip(injectMarker('plain stats      ', ' \u21bb 7', ' \u21bb 7')).trimEnd() === 'plain stats \u21bb 7' &&
		visibleWidth(injectMarker('plain stats      ', ' \u21bb 7', ' \u21bb 7')) === 17,
	JSON.stringify(strip(injectMarker('plain stats      ', ' \u21bb 7', ' \u21bb 7'))),
);
check('double-digit count fits', visibleWidth(injectMarker(`${'x'.repeat(20)} 39.3%/200k (auto)${' '.repeat(50)}model`, ' \u21bb 12', ' \u21bb 12')) === visibleWidth(`${'x'.repeat(20)} 39.3%/200k (auto)${' '.repeat(50)}model`));

// non-TUI modes must not install a footer
footerFactory = undefined;
handlers.get('session_start')(
	{ type: 'session_start', reason: 'resume' },
	{ ...ctx, mode: 'rpc', ui: { ...ctx.ui, setStatus: () => {} } },
);
check('rpc mode installs no footer', footerFactory === undefined);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
