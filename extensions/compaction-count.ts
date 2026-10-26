/**
 * compaction-count.ts — append the session's context-compaction count right after
 * `39.3%/200k (auto)` in Pi's footer stats line, rendered as `↻ 3`.
 *
 * Why it works this way
 * ---------------------
 * Pi's built-in footer stats line (↑ ↓ R W CH ctx%/(auto)) is hardcoded, and
 * `ctx.ui.setStatus()` renders on a *separate* line below the stats line — not
 * after `(auto)`. The only way to extend that line is `ctx.ui.setFooter()`,
 * which normally means rewriting the whole footer.
 *
 * So this extension *wraps* the built-in footer instead of replacing it:
 *   1. On `session_start`, one `setWidget` probe captures the TUI instance.
 *   2. The TUI component tree is searched for Pi's built-in FooterComponent,
 *      identified structurally (render + setSession + setAutoCompactEnabled).
 *   3. `setFooter()` installs a thin proxy that calls the built-in footer's
 *      `render(width)` and only splices the marker into line 2 (the stats line),
 *      immediately after `(auto)` — or after `39.3%/200k` when auto-compaction
 *      is disabled.
 *   4. The marker width is absorbed from the right-side padding, so the line
 *      width is unchanged and the model name stays right-aligned.
 *
 * Everything else the built-in footer renders (pwd, git branch, session name,
 * ↑↓RWCH, cost, context %, the (auto) flag, virtual-model routing arrow, and
 * other extensions' setStatus lines) is preserved verbatim, so this survives Pi
 * upgrades. If the probe ever fails, it degrades to a separate setStatus line.
 *
 * Commands: `/compactions` for a report, `/compactions hide|show` to toggle.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Glyph prefixed to the count in the stats line */
const MARKER = "↻";
/** setStatus key used only in the degraded fallback path */
const STATUS_KEY = "compaction-count";
/** Temporary widget key used for the TUI probe */
const PROBE_KEY = "compaction-count-probe";
/** Max depth when walking the component tree looking for the footer */
const MAX_PROBE_DEPTH = 12;
const ESC = "\u001b";

type WrappableFooter = Component & {
	setSession?: (session: unknown) => void;
	setAutoCompactEnabled?: (enabled: boolean) => void;
};

let activeCtx: ExtensionContext | undefined;
let liveTui: TUI | undefined;
/** Pi's built-in footer instance; reused across sessions (Pi rebinds it itself). */
let builtinFooter: WrappableFooter | undefined;
/** Refresh function used when the built-in footer could not be found. */
let fallbackRefresh: (() => void) | undefined;
let showMarker = true;
let cachedKey = "";
let cachedCount = 0;

// ---------------------------------------------------------------------------
// ANSI / width helpers
// ---------------------------------------------------------------------------

/** Skip the ANSI escape sequence starting at `i`; returns the index just past it. */
function skipEscape(text: string, i: number): number {
	const next = text[i + 1];
	if (next === "[") {
		// CSI: ESC [ ... final byte in 0x40-0x7e
		let j = i + 2;
		while (j < text.length) {
			const code = text.charCodeAt(j);
			if (code >= 0x40 && code <= 0x7e) return j + 1;
			j += 1;
		}
		return text.length;
	}
	if (next === "]" || next === "P" || next === "^" || next === "_") {
		// OSC / DCS…: terminated by BEL or ESC \
		let j = i + 2;
		while (j < text.length) {
			if (text.charCodeAt(j) === 0x07) return j + 1;
			if (text[j] === ESC && text[j + 1] === "\\") return j + 2;
			j += 1;
		}
		return text.length;
	}
	return i + 1;
}

/**
 * Split an ANSI-styled line into plain text plus a `plainIndex -> rawIndex` map.
 * `rawIndex[plain.length] === raw.length`, so the end maps cleanly too.
 */
function plainTextMap(raw: string): { plain: string; rawIndex: number[] } {
	let plain = "";
	const rawIndex: number[] = [];
	let i = 0;
	while (i < raw.length) {
		if (raw[i] === ESC) {
			i = skipEscape(raw, i);
			continue;
		}
		const code = raw.codePointAt(i);
		if (code === undefined) break;
		const ch = String.fromCodePoint(code);
		rawIndex.push(i);
		plain += ch;
		i += ch.length;
	}
	rawIndex.push(raw.length);
	return { plain, rawIndex };
}

/**
 * Index in the plain text where the marker belongs: right after `(auto)` when
 * auto-compaction is enabled, otherwise right after the `39.3%/200k` (or `?/200k`)
 * context segment. `fallback` marks the degenerate case where neither was found.
 */
function findInsertIndex(plain: string): { index: number; fallback: boolean } {
	const autoTail = "(auto)";
	const autoIdx = plain.lastIndexOf(autoTail);
	if (autoIdx >= 0) return { index: autoIdx + autoTail.length, fallback: false };

	const contextRe = /(?:\d+(?:\.\d+)?%|\?)\/\d+(?:\.\d+)?[kKmM]?/g;
	let last: RegExpExecArray | null = null;
	let match: RegExpExecArray | null;
	while ((match = contextRe.exec(plain)) !== null) last = match;
	if (last) return { index: last.index + last[0].length, fallback: false };
	// Degenerate layout: place the marker before the trailing padding, if any.
	return { index: plain.trimEnd().length, fallback: true };
}

/**
 * Splice the marker into the stats line without ever widening it: the marker's
 * width is taken from the trailing space padding so the model name stays
 * right-aligned. If the built-in footer already fills the width exactly (narrow
 * terminal), the line is truncated instead of overflowing. When the layout is
 * unrecognized and there is no padding to absorb, the line is left untouched
 * rather than mangled.
 */
export function injectMarker(line: string, plainMarker: string, styledMarker: string): string {
	const { plain, rawIndex } = plainTextMap(line);
	const anchor = findInsertIndex(plain);
	const insertAt = anchor.index;
	const markerWidth = visibleWidth(plainMarker);
	const at = Math.min(insertAt, rawIndex.length - 1);

	let spaces = 0;
	while (plain[insertAt + spaces] === " ") spaces += 1;
	if (anchor.fallback && spaces === 0) return line;
	const absorb = Math.min(markerWidth, spaces);

	const rawStart = rawIndex[at];
	const rawResume = rawIndex[Math.min(at + absorb, rawIndex.length - 1)];
	const candidate = line.slice(0, rawStart) + styledMarker + line.slice(rawResume);

	const originalWidth = visibleWidth(line);
	if (visibleWidth(candidate) > originalWidth) {
		return truncateToWidth(candidate, originalWidth, "");
	}
	return candidate;
}

// ---------------------------------------------------------------------------
// Compaction counting
// ---------------------------------------------------------------------------

function entryCountOf(sessionManager: ExtensionContext["sessionManager"]): number {
	const maybe = sessionManager as unknown as { getEntryCount?: () => number };
	if (typeof maybe.getEntryCount === "function") return maybe.getEntryCount();
	return sessionManager.getEntries().length;
}

/**
 * Number of `compaction` entries in the session tree. These are persisted in the
 * session file, so the count is correct after resume/fork too.
 * Memoized on (sessionId, leafId, entryCount) since the footer renders per frame.
 */
export function countCompactions(ctx: ExtensionContext | undefined): number {
	if (!ctx) return 0;
	try {
		const sm = ctx.sessionManager;
		const key = `${sm.getSessionId()}:${sm.getLeafId() ?? ""}:${entryCountOf(sm)}`;
		if (key === cachedKey) return cachedCount;
		let count = 0;
		for (const entry of sm.getEntries()) {
			if (entry.type === "compaction") count += 1;
		}
		cachedKey = key;
		cachedCount = count;
		return count;
	} catch {
		return cachedCount;
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatTime(timestamp: unknown): string {
	const date = typeof timestamp === "string" || typeof timestamp === "number" ? new Date(timestamp) : undefined;
	if (!date || Number.isNaN(date.getTime())) return "--:--:--";
	return date.toLocaleTimeString(undefined, { hour12: false });
}

// ---------------------------------------------------------------------------
// Locating the built-in footer
// ---------------------------------------------------------------------------

/** Walk the component tree and return Pi's built-in FooterComponent, if present. */
export function findFooterComponent(root: unknown): WrappableFooter | undefined {
	const seen = new Set<unknown>();
	const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];

	while (stack.length > 0) {
		const { node, depth } = stack.pop()!;
		if (node === null || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);

		const candidate = node as WrappableFooter;
		if (
			typeof candidate.render === "function" &&
			typeof candidate.setSession === "function" &&
			typeof candidate.setAutoCompactEnabled === "function"
		) {
			return candidate;
		}

		if (depth >= MAX_PROBE_DEPTH) continue;
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) stack.push({ node: child, depth: depth + 1 });
		}
	}
	return undefined;
}

/** Grab the TUI instance via a throwaway widget factory, then find the footer. */
function probeBuiltinFooter(ctx: ExtensionContext): WrappableFooter | undefined {
	let tui: TUI | undefined;
	try {
		// Widget factories are invoked synchronously with the TUI instance.
		ctx.ui.setWidget(PROBE_KEY, (instance: TUI) => {
			tui = instance;
			return { render: () => [], invalidate() {} };
		});
	} catch {
		tui = undefined;
	} finally {
		try {
			ctx.ui.setWidget(PROBE_KEY, undefined);
		} catch {
			// probe cleanup is best-effort
		}
	}
	if (!tui) return undefined;
	return findFooterComponent(tui);
}

// ---------------------------------------------------------------------------
// Proxy footer
// ---------------------------------------------------------------------------

class CountFooter implements Component {
	private readonly builtin: Component;
	private readonly theme: Theme;
	private readonly markerText: () => string | undefined;

	constructor(builtin: Component, theme: Theme, markerText: () => string | undefined) {
		this.builtin = builtin;
		this.theme = theme;
		this.markerText = markerText;
	}

	invalidate(): void {
		this.builtin.invalidate?.();
	}

	dispose(): void {
		// Pure proxy: the built-in footer instance is owned by Pi, never disposed here.
	}

	render(width: number): string[] {
		const lines = this.builtin.render(width);
		const marker = this.markerText();
		if (!marker) return lines;
		if (!Array.isArray(lines) || lines.length < 2) return lines;
		const statsLine = lines[1];
		if (typeof statsLine !== "string" || statsLine.length === 0) return lines;

		const next = [...lines];
		next[1] = injectMarker(statsLine, marker, this.theme.fg("dim", marker));
		return next;
	}
}

/** Separator between the glyph and the number, e.g. `↻ 3` */
const MARKER_GAP = " ";

function currentMarkerText(): string | undefined {
	if (!showMarker) return undefined;
	return ` ${MARKER}${MARKER_GAP}${countCompactions(activeCtx)}`;
}

function installFooter(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui" || !ctx.hasUI) return;
	activeCtx = ctx;

	if (!builtinFooter) builtinFooter = probeBuiltinFooter(ctx);

	if (!builtinFooter) {
		// Degraded path: a separate status line. Not the requested position, but safe.
		fallbackRefresh = () => {
			const marker = currentMarkerText();
			ctx.ui.setStatus(STATUS_KEY, marker ? `${marker.trim()} compactions` : undefined);
		};
		fallbackRefresh();
		return;
	}

	fallbackRefresh = undefined;
	try {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	} catch {
		// nothing to clear
	}

	const builtin = builtinFooter;
	ctx.ui.setFooter((tui, theme) => {
		liveTui = tui;
		return new CountFooter(builtin, theme, currentMarkerText);
	});
}

function refresh(): void {
	if (builtinFooter) {
		liveTui?.requestRender();
		return;
	}
	fallbackRefresh?.();
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

type CompactionRecord = { timestamp: unknown; tokensBefore?: number };

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Pi resets extension footers on session switch/reload, so reinstall here.
		installFooter(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		activeCtx = ctx;
		cachedKey = ""; // force recompute
		refresh();
	});

	pi.on("session_shutdown", () => {
		liveTui = undefined;
	});

	pi.registerCommand("compactions", {
		description: "Show this session's context-compaction count (/compactions hide|show toggles the footer marker)",
		handler: async (argsRaw, ctx) => {
			const arg = (argsRaw ?? "").trim().toLowerCase();

			if (arg === "hide" || arg === "off") {
				showMarker = false;
				refresh();
				ctx.ui.notify("Footer compaction marker hidden (/compactions show to restore)", "info");
				return;
			}
			if (arg === "show" || arg === "on") {
				showMarker = true;
				refresh();
				ctx.ui.notify(
					`Footer compaction marker shown: ${MARKER}${MARKER_GAP}${countCompactions(ctx)}`,
					"info",
				);
				return;
			}

			const compactions: CompactionRecord[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type !== "compaction") continue;
				compactions.push({
					timestamp: entry.timestamp,
					tokensBefore: typeof entry.tokensBefore === "number" ? entry.tokensBefore : undefined,
				});
			}

			const lines: string[] = [];
			lines.push(
				`Context compactions in this session: ${compactions.length}` +
					(showMarker
						? ` (footer marker ${MARKER}${MARKER_GAP}${compactions.length})`
						: " (footer marker hidden)"),
			);
			compactions.forEach((item, index) => {
				const before = item.tokensBefore === undefined ? "unknown" : `${formatTokens(item.tokensBefore)} tokens`;
				lines.push(`  ${index + 1}. ${formatTime(item.timestamp)} · before ${before}`);
			});
			if (compactions.length === 0) lines.push("  No context compaction has happened in this session yet.");
			lines.push(
				`Marker position: end of the stats line, e.g. 39.3%/200k (auto) ${MARKER}${MARKER_GAP}2`,
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
