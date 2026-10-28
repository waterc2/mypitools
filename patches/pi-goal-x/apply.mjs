#!/usr/bin/env node
/**
 * Idempotent applier for the pi-goal-x "pause-on-create" local patch.
 *
 * PURPOSE: pi-goal-x lives in the package install tree
 *   (~/.pi/agent/npm/node_modules/pi-goal-x) and any `pi update` / reinstall
 *   replaces it, silently dropping the patch. This script re-applies the
 *   tracked unified diff (pause-on-create.patch, same directory) whenever the
 *   marker is missing, so recovery is one command (or automatic — see
 *   ~/.pi/agent/extensions/pi-goal-x-reapply.ts).
 *
 * INPUT:   pause-on-create.patch next to this file.
 *          Target package dir: $PI_GOAL_X_DIR or ~/.pi/agent/npm/node_modules/pi-goal-x.
 * MUTATION: rewrites the 7 patched files under <pkg>/extensions via `git apply`
 *          (fallback: `patch`). Never writes when the marker is already present.
 *          Logs each run to ~/.pi/agent/pi-goal-x-reapply.log.
 * DETERMINISM: byte-for-byte identical diff, no randomness. The only clock use
 *          is the diagnostic timestamp in the log.
 *
 * Usage:
 *   node apply.mjs            # apply if missing (idempotent)
 *   node apply.mjs --check    # report status only; exit 0 patched, 1 unpatched
 *   node apply.mjs --revert   # undo the patch
 *   node apply.mjs --quiet     # suppress the human summary line (for the extension)
 *
 * Exit codes: 0 already patched / check:patched / reverted
 *             1 unpatched (only with --check)
 *             2 target missing (`pi install npm:pi-goal-x` first)
 *             3 the upstream anchor moved — the patch no longer applies cleanly
 *             4 the apply command failed for another reason
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCH = join(HERE, "pause-on-create.patch");
/** Injected into extensions/goal-state.ts; the single source of truth for "patched". */
const MARKER = "pi-goal-x-local-patch:pause-on-create";
const MARKER_FILE = join("extensions", "goal-state.ts");
const LOG = join(homedir(), ".pi", "agent", "pi-goal-x-reapply.log");

const pkgDir =
	process.env.PI_GOAL_X_DIR ??
	join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-goal-x");

const argv = new Set(process.argv.slice(2));
const checkOnly = argv.has("--check");
const revert = argv.has("--revert");
const quiet = argv.has("--quiet") || argv.has("--json");

function emit(status, detail) {
	if (quiet) {
		process.stdout.write(`${JSON.stringify({ status, detail, pkgDir })}\n`);
	} else {
		process.stdout.write(`[pi-goal-x patch] ${status}${detail ? `: ${detail}` : ""}\n`);
	}
}

function log(tag, message) {
	try {
		appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${message}\n`);
	} catch {
		/* diagnostics are best-effort */
	}
}

function isPatched() {
	try {
		return readFileSync(join(pkgDir, MARKER_FILE), "utf8").includes(MARKER);
	} catch {
		return false;
	}
}

/** Run `git apply` first (keeps a/ b/ prefixes and is strict), then `patch`. */
function runApply(extraArgs) {
	const attempts = [
		{ cmd: "git", args: ["apply", "-p1", ...(revert ? ["-R"] : []), ...extraArgs, PATCH] },
		{ cmd: "patch", args: ["-p1", "--forward", ...(revert ? ["--reverse"] : []), ...extraArgs, "-i", PATCH] },
	];
	let lastError = "";
	for (const attempt of attempts) {
		const result = spawnSync(attempt.cmd, attempt.args, { cwd: pkgDir, encoding: "utf8" });
		if (result.error) {
			lastError = `${attempt.cmd}: ${result.error.message}`;
			continue; // tool not installed — try the next one
		}
		if (result.status === 0) return { ok: true, cmd: attempt.cmd };
		lastError = `${attempt.cmd}: ${(result.stderr || result.stdout || "").trim().split("\n")[0]}`;
	}
	return { ok: false, error: lastError };
}

if (!existsSync(pkgDir)) {
	log("skip", `target package not installed: ${pkgDir}`);
	emit("not-installed", pkgDir);
	process.exit(2);
}

if (revert) {
	if (!isPatched()) {
		emit("already-unpatched", "");
		process.exit(0);
	}
	const precheck = runApply(["--check"]);
	if (!precheck.ok) {
		log("revert", `check failed: ${precheck.error}`);
		emit("revert-failed", precheck.error);
		process.exit(precheck.error.includes("does not apply") ? 3 : 4);
	}
	const revertRun = runApply([]);
	if (!revertRun.ok) {
		log("revert", `failed: ${revertRun.error}`);
		emit("revert-failed", revertRun.error);
		process.exit(revertRun.error.includes("does not apply") ? 3 : 4);
	}
	log("revert", `reverted via ${revertRun.cmd}`);
	emit("reverted", `via ${revertRun.cmd}`);
	process.exit(0);
}

if (isPatched()) {
	emit("already-patched", "");
	process.exit(0);
}

if (checkOnly) {
	emit("unpatched", "");
	process.exit(1);
}

const result = runApply([]);
if (!result.ok) {
	log("apply", `failed: ${result.error}`);
	emit("apply-failed", result.error);
	process.exit(result.error.includes("does not apply") ? 3 : 4);
}
if (!isPatched()) {
	// The command exited 0 but the marker is absent: the patch landed somewhere
	// unexpected. Report loudly rather than claiming success.
	log("apply", "apply command succeeded but the marker is missing");
	emit("apply-unverified", "marker missing after apply");
	process.exit(4);
}
log("apply", `applied via ${result.cmd}`);
emit("patched", `via ${result.cmd}`);
