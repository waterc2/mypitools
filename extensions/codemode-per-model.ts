// PURPOSE: hide the `codemode` tool from specific models only, without disabling it
//          globally. `settings.defaultTools` is a single global list with no per-model
//          branch, so this has to be done with an extension.
// INPUT:   ~/.pi/agent/codemode-per-model.json
//            { "disabledModels": ["Local", "mytoken/Local"], "tools": ["codemode"] }
//          Entries match either the bare model id (`Local`) or `provider/model`.
//          Matching is exact + case-insensitive, so `Local` never matches `Local-large`.
//          Missing/corrupt file = nothing disabled = no-op (fail open, never throws).
// MUTATION: for a matched model, removes the listed tools from pi's ACTIVE tool set
//           (pi.setActiveTools -> rebuilds the system prompt tool section, so the model
//           stops seeing them) AND blocks them at execution time via `tool_call`.
//           The tool registry is never touched: switching to another model restores
//           only tools this extension removed, when they are registered and allowed again.
// WHY THE tool_call GUARD: pi freezes the session's initial tool definitions in the
//           prompt prefix for provider cache stability and only announces removals via a
//           transcript delta, so a removed tool can stay *callable by name*. The guard
//           makes the disabling real rather than cosmetic.
// DETERMINISM: pure name matching; no randomness, no clock, no timers.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "codemode-per-model.json");
const DEFAULT_TOOLS = ["codemode"];

interface Config {
	models: Set<string>;
	tools: string[];
}

function loadConfig(): Config {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
		const list = Array.isArray(parsed?.disabledModels) ? parsed.disabledModels : [];
		const models = new Set(
			list
				.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
				.map((n) => n.trim().toLowerCase()),
		);
		const tools = Array.isArray(parsed?.tools)
			? [...new Set(parsed.tools
				.filter((t): t is string => typeof t === "string" && t.trim().length > 0)
				.map((t) => t.trim()))]
			: DEFAULT_TOOLS;
		// An explicit empty list disables this policy; omitted tools use the default.
		return { models, tools };
	} catch {
		return { models: new Set(), tools: DEFAULT_TOOLS };
	}
}

/** Whether the model is listed in the config, by bare id or `provider/id`. */
function isDisabled(cfg: Config, model: { provider: string; id: string } | undefined): boolean {
	if (!model || cfg.models.size === 0) return false;
	return (
		cfg.models.has(`${model.provider}/${model.id}`.toLowerCase()) || cfg.models.has(model.id.toLowerCase())
	);
}

export default function codemodePerModel(pi: ExtensionAPI) {
	let cfg = loadConfig();
	/** Fallback when an event context does not expose a model. */
	let currentModel: { provider: string; id: string } | undefined;
	/** Tools we removed for the current model, so we can put them back on a switch. */
	const hidden = new Set<string>();

	/**
	 * Reconcile the active tool set with the current model. Only calls setActiveTools
	 * when something actually changes, so a steady state never emits a tool-set
	 * transition (which would bust the provider's cached prompt prefix).
	 */
	function apply(): void {
		let active: string[];
		try {
			active = pi.getActiveTools();
		} catch {
			return; // extension loading phase: not ready yet
		}
		if (!Array.isArray(active)) return;

		const blocked = new Set(isDisabled(cfg, currentModel) ? cfg.tools : []);
		const present = active.filter((name) => blocked.has(name));
		const released = [...hidden].filter((name) => !blocked.has(name));
		let restore: string[] = [];
		if (released.length > 0) {
			// Active tools are not the registry. Do not revive withdrawn/hidden tools.
			const registered = new Set(pi.getAllTools()
				.filter((tool) => tool.exposure !== "hidden")
				.map((tool) => tool.name));
			restore = released.filter((name) => registered.has(name) && !active.includes(name));
		}
		const next = [...active.filter((name) => !blocked.has(name)), ...restore];
		if (present.length > 0 || restore.length > 0) pi.setActiveTools(next);
		// Commit bookkeeping after the tool update succeeds. Accumulate removals,
		// including partial reactivations by another extension, instead of replacing them.
		for (const name of present) hidden.add(name);
		for (const name of released) hidden.delete(name);
	}

	// Re-read the JSON at session start so edits take effect on /reload.
	pi.on("session_start", async (_event, ctx) => {
		cfg = loadConfig();
		currentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		apply();
	});

	// React to an explicit model switch right away.
	pi.on("model_select", (event, _ctx) => {
		cfg = loadConfig();
		currentModel = { provider: event.model.provider, id: event.model.id };
		apply();
	});

	// Re-assert every run: freshly registered tools (MCP sync, lazy registration,
	// other extensions) would otherwise re-activate themselves. The JSON is re-read
	// here too, so an edit takes effect on the next turn without a /reload.
	pi.on("before_agent_start", async (_event, ctx) => {
		cfg = loadConfig();
		if (ctx.model) currentModel = { provider: ctx.model.provider, id: ctx.model.id };
		apply();
	});

	// Also reconcile between model requests: lazy registration can happen mid-run.
	pi.on("turn_start", (_event, ctx) => {
		cfg = loadConfig();
		if (ctx.model) currentModel = { provider: ctx.model.provider, id: ctx.model.id };
		apply();
	});

	// Hard guard also covers stale history and calls nested inside other tools.
	pi.on("tool_call", async (event, ctx) => {
		cfg = loadConfig();
		if (!cfg.tools.includes(event.toolName)) return undefined;
		const model = ctx.model ?? currentModel;
		if (!isDisabled(cfg, model)) return undefined;
		return {
			block: true,
			reason: `Tool "${event.toolName}" is disabled for model "${model?.provider ?? "?"}/${model?.id ?? "?"}" by ~/.pi/agent/codemode-per-model.json`,
		};
	});

	pi.registerCommand("codemode-per-model", {
		description: "Show which models have codemode hidden (edit ~/.pi/agent/codemode-per-model.json, then /reload)",
		handler: async (_args, ctx) => {
			cfg = loadConfig();
			if (ctx.model) currentModel = { provider: ctx.model.provider, id: ctx.model.id };
			apply();
			const model = currentModel;
			const active = pi.getActiveTools();
			const listed = [...cfg.models].join(", ") || "(empty)";
			const lines = [
				`disabled models (${cfg.models.size}): ${listed}`,
				`guarded tools: ${cfg.tools.join(", ")}`,
				`current model: ${model ? `${model.provider}/${model.id}` : "(none)"}`,
				`current match: ${isDisabled(cfg, model) ? "YES (execution blocked for guarded tools)" : "no"}`,
				`guarded tools still active: ${cfg.tools.filter((t) => active.includes(t)).join(", ") || "(none)"}`,
				`removed by this extension: ${[...hidden].join(", ") || "(none)"}`,
				"hard guard: tool_call blocks guarded tools at execution time",
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
