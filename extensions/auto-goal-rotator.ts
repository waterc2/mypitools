/**
 * PURPOSE: When a focused goal is active and compaction FAILS to shrink the
 *   context, rotate to a fresh session. A new session reloads the goal from disk
 *   via /goal-resume, so the run continues without the history that compaction
 *   could not summarize.
 * INPUT: session_compact_failed (the only trigger); ctx.getContextUsage() is read
 *   for the notification only, never as a threshold; focused goal files under
 *   <cwd>/.pi/goals/ (same files pi-goal-x persists).
 * MUTATION: writes one handoff flag under os.tmpdir(), then calls ctx.newSession()
 *   and, in the replacement session, sends "/goal-resume". Deletes the flag after
 *   resume or on failure. Never writes goal files, settings, or the transcript.
 * DETERMINISM: wall-clock cooldown only. No randomness. No-ops unless a goal is
 *   active (or a handoff flag from the previous session of this cwd is waiting),
 *   so ordinary non-goal sessions are untouched.
 *
 * Why this is not the sample that calls pi.on("error") / pi.executeCommand("new"):
 *   this pi build has no "error" extension event and no executeCommand. Compaction
 *   failure is session_compact_failed. /new is ctx.newSession(), and it is only
 *   legal from a command context — event-handler ctx does not have it — so the rotate
 *   is registered as the slash command "goal-rotate" and invoked through
 *   sendUserMessage("/goal-rotate", { expandPromptTemplates: true }).
 */

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Ignore a second trigger this soon after one we already accepted. */
const COOLDOWN_MS = 60_000;
/** Wait for pi-goal-x session_start (loadState + scheduler.restore) before resume. */
const RESUME_DELAY_MS = 1500;
/** Drop a flag nobody resumed, so a later manual /new cannot surprise-resume. */
const FLAG_MAX_AGE_MS = 10 * 60_000;

const FLAG_PREFIX = "pi-goal-auto-rotate-";

interface HandoffFlag {
	cwd: string;
	at: number;
	reason: string;
	tokens: number | null;
	contextWindow: number | null;
}

interface RotatorState {
	lastTriggerAt: number;
	/** Set the moment we decide to rotate; blocks the resume loop from rotating again. */
	rotating: boolean;
	/** The session that wrote the flag. Its own session_start must not resume. */
	triggeredSessionId: string | undefined;
	resumeTimer: ReturnType<typeof setTimeout> | undefined;
}

function flagPath(cwd: string): string {
	const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return join(tmpdir(), `${FLAG_PREFIX}${hash}.json`);
}

function readFlag(cwd: string): HandoffFlag | undefined {
	const path = flagPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<HandoffFlag>;
		if (raw.cwd !== cwd || typeof raw.at !== "number") return undefined;
		if (Date.now() - raw.at > FLAG_MAX_AGE_MS) {
			unlinkSync(path);
			return undefined;
		}
		return {
			cwd,
			at: raw.at,
			reason: typeof raw.reason === "string" ? raw.reason : "handoff",
			tokens: typeof raw.tokens === "number" ? raw.tokens : null,
			contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : null,
		};
	} catch {
		return undefined;
	}
}

function writeFlag(flag: HandoffFlag): void {
	writeFileSync(flagPath(flag.cwd), `${JSON.stringify(flag)}\n`, "utf-8");
}

function clearFlag(cwd: string): void {
	const path = flagPath(cwd);
	if (existsSync(path)) unlinkSync(path);
}

/**
 * True when this cwd has a non-complete goal pi-goal-x would keep running.
 * Mirrors goal-pool: files are active_goal_*.md (or the legacy active_goal.md)
 * and `"status": "complete"` goals are not open. A paused goal is still open —
 * /goal-resume is exactly what continues it — but we only rotate while one is
 * active, so a paused goal never starts a rotate by itself.
 */
function focusedGoalStatus(cwd: string): "active" | "paused" | "other" | "none" {
	const dir = join(cwd, ".pi", "goals");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return "none";
	}
	let sawOpen = false;
	let sawPaused = false;
	for (const name of names) {
		const legacy = name === "active_goal.md";
		const current = name.startsWith("active_goal_") && name.endsWith(".md");
		if (!legacy && !current) continue;
		let text: string;
		try {
			text = readFileSync(join(dir, name), "utf-8");
		} catch {
			continue;
		}
		const status = text.match(/"status"\s*:\s*"([^"]+)"/)?.[1];
		if (!status || status === "complete") continue;
		sawOpen = true;
		if (status === "paused") sawPaused = true;
		else if (status === "active") return "active";
	}
	if (sawPaused) return "paused";
	return sawOpen ? "other" : "none";
}

function describeUsage(tokens: number | null, contextWindow: number | null): string {
	if (tokens === null || contextWindow === null || contextWindow <= 0) return "context occupancy unknown";
	const percent = Math.round((tokens / contextWindow) * 100);
	return `${Math.round(tokens / 1000)}k/${Math.round(contextWindow / 1000)}k (${percent}%)`;
}

export default function autoGoalRotator(pi: ExtensionAPI) {
	const state: RotatorState = {
		lastTriggerAt: 0,
		rotating: false,
		triggeredSessionId: undefined,
		resumeTimer: undefined,
	};

	function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		try {
			ctx.ui.notify(message, level);
		} catch {
			// Notification failure must not sink the turn.
		}
	}

	/**
	 * Ask the command runtime to rotate. The session_compact_failed context cannot
	 * call newSession(); expandPromptTemplates dispatches the extension command
	 * instead of delivering "/goal-rotate" to the model.
	 */
	function requestRotate(ctx: ExtensionContext, reason: string, tokens: number | null, contextWindow: number | null): void {
		if (state.rotating) return;
		if (focusedGoalStatus(ctx.cwd) !== "active") return;
		const now = Date.now();
		if (now - state.lastTriggerAt < COOLDOWN_MS) return;
		state.lastTriggerAt = now;
		state.rotating = true;
		state.triggeredSessionId = ctx.sessionManager.getSessionId();
		try {
			writeFlag({ cwd: ctx.cwd, at: now, reason, tokens, contextWindow });
		} catch (error) {
			state.rotating = false;
			state.triggeredSessionId = undefined;
			notify(ctx, `[Auto-Rotator] could not write handoff flag: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		notify(
			ctx,
			`[Auto-Rotator] ${reason} (${describeUsage(tokens, contextWindow)}). Rotating to a fresh session and resuming the goal.`,
			"warning",
		);
		try {
			pi.sendUserMessage("/goal-rotate", { deliverAs: "followUp", expandPromptTemplates: true });
		} catch (error) {
			state.rotating = false;
			state.triggeredSessionId = undefined;
			clearFlag(ctx.cwd);
			notify(ctx, `[Auto-Rotator] could not dispatch rotate: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	pi.registerCommand("goal-rotate", {
		description: "Internal: start a fresh session and resume the active goal. Invoked by auto-goal-rotator.",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const flag = readFlag(ctx.cwd);
			if (!flag) {
				// Typed by hand with no pending handoff: do nothing rather than wipe the session.
				ctx.ui.notify("[Auto-Rotator] no pending goal handoff; session left as-is.", "info");
				state.rotating = false;
				return;
			}
			try {
				const result = await ctx.newSession({
					withSession: async (next) => {
						// pi-goal-x reloads the pool inside its own session_start, which
						// runs before withSession. Give it a moment, then resume.
						state.resumeTimer = setTimeout(() => {
							state.resumeTimer = undefined;
							void (async () => {
								try {
									if (readFlag(next.cwd)?.at !== flag.at) return;
									clearFlag(next.cwd);
									state.rotating = false;
									next.ui.notify("[Auto-Rotator] fresh session is up; resuming the goal.", "info");
									await next.sendUserMessage("/goal-resume", { expandPromptTemplates: true });
								} catch (error) {
									state.rotating = false;
									clearFlag(next.cwd);
									next.ui.notify(
										`[Auto-Rotator] resume failed: ${error instanceof Error ? error.message : String(error)}. Run /goal-resume.`,
										"error",
									);
								}
							})();
						}, RESUME_DELAY_MS);
						state.resumeTimer.unref?.();
					},
				});
				if (result.cancelled) {
					state.rotating = false;
					state.triggeredSessionId = undefined;
					clearFlag(ctx.cwd);
					ctx.ui.notify("[Auto-Rotator] new session was cancelled; staying here.", "warning");
				}
			} catch (error) {
				state.rotating = false;
				state.triggeredSessionId = undefined;
				clearFlag(ctx.cwd);
				ctx.ui.notify(
					`[Auto-Rotator] new session failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("session_shutdown", async () => {
		if (state.resumeTimer) {
			clearTimeout(state.resumeTimer);
			state.resumeTimer = undefined;
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "new" && event.reason !== "startup") return;
		const flag = readFlag(ctx.cwd);
		if (!flag) return;
		// The session that armed the flag is still starting up (startup) or the
		// command handler's withSession owns the resume (new). Don't double-resume.
		if (ctx.sessionManager.getSessionId() === state.triggeredSessionId) return;
		if (state.resumeTimer) return;
		state.resumeTimer = setTimeout(() => {
			state.resumeTimer = undefined;
			void (async () => {
				try {
					if (readFlag(ctx.cwd)?.at !== flag.at) return;
					if (focusedGoalStatus(ctx.cwd) === "none") {
						clearFlag(ctx.cwd);
						return;
					}
					clearFlag(ctx.cwd);
					state.rotating = false;
					notify(ctx, "[Auto-Rotator] fresh session is up; resuming the goal.", "info");
					pi.sendUserMessage("/goal-resume", { expandPromptTemplates: true });
				} catch (error) {
					state.rotating = false;
					clearFlag(ctx.cwd);
					notify(ctx, `[Auto-Rotator] resume failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			})();
		}, RESUME_DELAY_MS);
		state.resumeTimer.unref?.();
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		if (event.aborted || state.rotating) return;
		if (focusedGoalStatus(ctx.cwd) !== "active") return;
		const usage = ctx.getContextUsage();
		const detail = event.errorMessage ? `: ${event.errorMessage}` : "";
		requestRotate(ctx, `compaction failed (${event.reason})${detail}`, usage?.tokens ?? null, usage?.contextWindow ?? null);
	});
}
