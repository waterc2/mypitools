/**
 * Model Carry-Over Extension
 *
 * PURPOSE: `pi` re-resolves model + thinking level from settings every time a new
 *   session starts (`/new`, `app.session.new`). If `defaultModel` is not configured,
 *   that resolution falls back to "first available model" + thinking `medium`.
 *   This extension remembers the model and thinking level you last used and re-applies
 *   them to the new session, so `/new` keeps your working setup.
 * INPUT: ~/.pi/agent/model-carryover.json
 *   { enabled, applyOnStartup, provider, model, thinkingLevel, updatedAt }
 * MUTATION: writes only that JSON file; changes the CURRENT session's model/thinking via
 *   pi.setModel() / pi.setThinkingLevel() (never rewrites settings.json defaults).
 * DETERMINISM: no timers, no network, no randomness. Apply is guarded by `applying` so the
 *   model_select / thinking_level_select events it causes are not re-recorded as a user change.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE_FILE_NAME = "model-carryover.json";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

interface CarryState {
	enabled: boolean;
	/** Also re-apply on process startup (`pi` with no --continue/--resume). */
	applyOnStartup: boolean;
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	updatedAt: string;
}

function statePath(): string {
	return join(getAgentDir(), STATE_FILE_NAME);
}

function readState(): CarryState | undefined {
	const path = statePath();
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CarryState>;
		if (typeof raw.provider !== "string" || typeof raw.model !== "string") return undefined;
		return {
			enabled: raw.enabled !== false,
			applyOnStartup: raw.applyOnStartup === true,
			provider: raw.provider,
			model: raw.model,
			thinkingLevel: (raw.thinkingLevel ?? "medium") as ThinkingLevel,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
		};
	} catch {
		return undefined;
	}
}

function writeState(state: CarryState): boolean {
	try {
		writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}

export default function modelCarryOver(pi: ExtensionAPI) {
	/** True while we apply the carried-over state, so our own select events are ignored. */
	let applying = false;

	function snapshot(ctx: ExtensionContext): Omit<CarryState, "enabled" | "applyOnStartup" | "updatedAt"> | undefined {
		const model = ctx.model;
		if (!model) return undefined;
		return {
			provider: model.provider,
			model: model.id,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	function record(ctx: ExtensionContext): void {
		if (applying) return;
		const snap = snapshot(ctx);
		if (!snap) return;
		const previous = readState();
		writeState({
			enabled: previous?.enabled ?? true,
			applyOnStartup: previous?.applyOnStartup ?? false,
			...snap,
			updatedAt: new Date().toISOString(),
		});
	}

	async function applyCarryOver(ctx: ExtensionContext, reason: "new" | "startup"): Promise<void> {
		const state = readState();
		if (!state || !state.enabled) return;
		if (reason === "startup" && !state.applyOnStartup) return;

		const target = ctx.modelRegistry.find(state.provider, state.model);
		if (!target) {
			ctx.ui.notify(`carry-over: model ${state.provider}/${state.model} is no longer available`, "warning");
			return;
		}

		const current = ctx.model;
		applying = true;
		try {
			const applied = await pi.setModel(target);
			if (!applied) {
				ctx.ui.notify(`carry-over: no auth for ${state.provider}/${state.model}`, "warning");
				return;
			}
			pi.setThinkingLevel(state.thinkingLevel);
			const thinking = pi.getThinkingLevel();
			if (thinking !== state.thinkingLevel) {
				ctx.ui.notify(
					`carry-over: ${state.provider}/${state.model} (thinking "${state.thinkingLevel}" unsupported, using "${thinking}")`,
					"info",
				);
			} else if (current?.provider !== target.provider || current?.id !== target.id) {
				ctx.ui.notify(`carry-over: ${target.provider}/${target.id} · thinking ${thinking}`, "info");
			}
		} finally {
			applying = false;
		}
	}

	// Remember changes as they happen (survives crashes and quit-without-shutdown).
	pi.on("model_select", (_event, ctx) => {
		record(ctx);
	});
	pi.on("thinking_level_select", (_event, ctx) => {
		record(ctx);
	});

	// Best-effort capture before the session goes away.
	pi.on("session_before_switch", (_event, ctx) => {
		record(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		record(ctx);
	});

	// Re-apply in the freshly created session.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new") {
			await applyCarryOver(ctx, "new");
			return;
		}
		if (event.reason === "startup") {
			await applyCarryOver(ctx, "startup");
			return;
		}
		// "resume" / "fork" already restore the session's own model and thinking.
		record(ctx);
	});

	pi.registerCommand("carry-model", {
		description: "Keep the last model + thinking level across /new. Status, on/off, pin, startup.",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const previous = readState();

			if (sub === "off" || sub === "disable") {
				writeState({
					enabled: false,
					applyOnStartup: previous?.applyOnStartup ?? false,
					provider: previous?.provider ?? ctx.model?.provider ?? "",
					model: previous?.model ?? ctx.model?.id ?? "",
					thinkingLevel: previous?.thinkingLevel ?? pi.getThinkingLevel(),
					updatedAt: new Date().toISOString(),
				});
				ctx.ui.notify("carry-over disabled: /new uses settings defaults", "info");
				return;
			}

			if (sub === "on" || sub === "enable") {
				const snap = snapshot(ctx);
				if (!snap) {
					ctx.ui.notify("carry-over: no model selected yet", "warning");
					return;
				}
				writeState({
					enabled: true,
					applyOnStartup: previous?.applyOnStartup ?? false,
					...snap,
					updatedAt: new Date().toISOString(),
				});
				ctx.ui.notify(`carry-over enabled: ${snap.provider}/${snap.model} · ${snap.thinkingLevel}`, "info");
				return;
			}

			if (sub === "pin") {
				const snap = snapshot(ctx);
				if (!snap) {
					ctx.ui.notify("carry-over: no model selected yet", "warning");
					return;
				}
				writeState({
					enabled: previous?.enabled ?? true,
					applyOnStartup: previous?.applyOnStartup ?? false,
					...snap,
					updatedAt: new Date().toISOString(),
				});
				ctx.ui.notify(`carry-over pinned: ${snap.provider}/${snap.model} · ${snap.thinkingLevel}`, "info");
				return;
			}

			if (sub === "startup" || sub === "startup on" || sub === "startup off") {
				const value = sub === "startup off" ? false : true;
				const snap = snapshot(ctx) ?? {
					provider: previous?.provider ?? "",
					model: previous?.model ?? "",
					thinkingLevel: previous?.thinkingLevel ?? pi.getThinkingLevel(),
				};
				if (!snap.provider || !snap.model) {
					ctx.ui.notify("carry-over: nothing to apply on startup yet", "warning");
					return;
				}
				writeState({
					enabled: previous?.enabled ?? true,
					applyOnStartup: value,
					...snap,
					updatedAt: new Date().toISOString(),
				});
				ctx.ui.notify(`carry-over on process startup: ${value ? "on" : "off"}`, "info");
				return;
			}

			const state = readState();
			const lines = [
				`carry-over: ${state?.enabled === false ? "disabled" : "enabled"}`,
				`state file: ${statePath()}`,
				state
					? `carries: ${state.provider}/${state.model} · thinking ${state.thinkingLevel}`
					: "carries: (nothing recorded yet)",
				`apply on startup: ${state?.applyOnStartup ? "on" : "off"}`,
				`current session: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)"} · thinking ${pi.getThinkingLevel()}`,
				"",
				"subcommands: on | off | pin | startup on | startup off",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
