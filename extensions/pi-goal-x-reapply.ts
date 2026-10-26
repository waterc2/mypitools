// PURPOSE: keep the pi-goal-x "pause-on-create" local patch applied across
//          package updates. pi-goal-x lives in the install tree
//          (~/.pi/agent/npm/node_modules/pi-goal-x); `pi update` / reinstall
//          replaces it and silently drops the patch, which reverts /goal back to
//          running immediately. This extension re-applies the tracked diff and
//          tells the user, so an update cannot silently change behavior.
// INPUT:   ~/.pi/agent/patches/pi-goal-x/{apply.mjs,pause-on-create.patch} and
//          the installed package (marker in extensions/goal-state.ts).
// MUTATION: spawns apply.mjs ONLY when the marker is missing (it rewrites the 7
//          patched files under the package). Logs to
//          ~/.pi/agent/pi-goal-x-reapply.log. Never writes when already patched.
//          Fails open: any error is logged and the session continues.
// DETERMINISM: no randomness; the only clock use is the diagnostic log timestamp.
//
// WHY the notification says "restart": packages load BEFORE user extensions
// (verified in dist/core/package-manager.js resolve(): resolvePackageSources runs
// first, addAutoDiscoveredResources last), so pi-goal-x's modules are already
// imported by the time this file's top level runs. A heal therefore takes effect
// from the NEXT process start. The heal still matters: it repairs the install
// tree now and surfaces that an update dropped the patch.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const PKG_DIR = process.env.PI_GOAL_X_DIR ?? join(AGENT_DIR, "npm", "node_modules", "pi-goal-x");
const APPLIER = join(AGENT_DIR, "patches", "pi-goal-x", "apply.mjs");
const MARKER_FILE = join(PKG_DIR, "extensions", "goal-state.ts");
const MARKER = "pi-goal-x-local-patch:pause-on-create";
const LOG = join(AGENT_DIR, "pi-goal-x-reapply.log");

type HealResult = "already-patched" | "patched" | "not-installed" | "failed";

function log(message: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} [pi-goal-x-reapply] ${message}\n`);
	} catch {
		/* diagnostics are best-effort */
	}
}

/**
 * Interpreters that can run apply.mjs. `process.execPath` is only used when it
 * actually looks like node/bun: a compiled pi binary sets execPath to itself,
 * and spawning that with a script argument would re-launch pi.
 */
function interpreterCandidates(): string[] {
	const candidates: string[] = [];
	if (process.env.PI_NODE_BIN) candidates.push(process.env.PI_NODE_BIN);
	if (/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) candidates.push(process.execPath);
	candidates.push("node", "bun");
	return candidates;
}

function heal(): HealResult {
	let current: string;
	try {
		current = readFileSync(MARKER_FILE, "utf8");
	} catch {
		return "not-installed"; // pi-goal-x is not installed (or was removed)
	}
	if (current.includes(MARKER)) return "already-patched";

	for (const interpreter of interpreterCandidates()) {
		const result = spawnSync(interpreter, [APPLIER, "--quiet"], { encoding: "utf8" });
		if (result.error || result.status === null) continue; // interpreter unavailable — try the next
		const line = (result.stdout ?? "").trim().split("\n").pop() ?? "";
		let status: string | undefined;
		try {
			status = (JSON.parse(line) as { status?: string }).status;
		} catch {
			status = undefined;
		}
		if (status === "patched") {
			log(`re-applied after an update (interpreter: ${interpreter})`);
			return "patched";
		}
		if (status === "already-patched") return "already-patched";
		if (status === "not-installed") return "not-installed";
		// apply-failed / apply-unverified: upstream changed shape. Log the detail
		// and stop — do not retry other interpreters for a content failure.
		log(`apply did not succeed (${status ?? "unparsed output"}): ${line.slice(0, 400)}`);
		return "failed";
	}
	log("no usable node/bun interpreter found; patch NOT re-applied");
	return "failed";
}

/** Heal once while this extension loads, before any session begins. */
let pendingNotice = false;
try {
	pendingNotice = heal() === "patched";
} catch (error) {
	log(`load-time heal threw: ${error instanceof Error ? error.message : String(error)}`);
}

type SessionStartPi = {
	on?: (
		event: "session_start",
		handler: (event: unknown, ctx: { ui: { notify: (message: string, level?: string) => void } }) => unknown,
	) => unknown;
};

export default function piGoalXPatchReapply(pi: SessionStartPi): void {
	// Re-check at every session start: a `pi update` between sessions leaves the
	// install tree unpatched, and this repairs it. The notice fires only when a
	// heal actually happened, so already-patched sessions stay silent.
	pi?.on?.("session_start", async (_event, ctx) => {
		try {
			if (heal() === "patched") pendingNotice = true;
		} catch (error) {
			log(`session_start heal threw: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (!pendingNotice) return;
		pendingNotice = false;
		// Packages load before user extensions, so pi-goal-x's modules are already
		// imported in this process; the repaired files take effect on next start.
		ctx?.ui?.notify(
			"pi-goal-x patch re-applied (pause-on-create). The running session still uses the previous code — restart pi to activate it.",
			"warning",
		);
	});
}
