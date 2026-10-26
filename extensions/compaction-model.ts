/**
 * PURPOSE: High-fidelity, independently modeled compaction with detailed state/evidence ledgers.
 * INPUT: compaction-model.json and Pi's canonical projected compaction preparation.
 * MUTATION: Returns checkpoints; appends metadata-only audit entries. Never edits main-model config/history.
 * DETERMINISM: Deterministic budgets/excerpts; nested model output is nondeterministic.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildSessionProjection, getAgentDir, generateBranchSummary,
  type ExtensionAPI, type ExtensionContext, type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {
  checkpoint, parseConfig, DEFAULTS, plan, serialize, tokens,
  addUsage, type Config, type Complete, type Message, type Usage, type SourceIdentity,
} from '../lib/high-fidelity-compaction/core.ts';
import type { CriticalRecord } from '../lib/high-fidelity-compaction/preservation.ts';

const CONFIG_FILE = `${getAgentDir()}/compaction-model.json`;
function loadConfig(): Config {
  try { return parseConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw error;
  }
}
function modelFor(ref: string, ctx: ExtensionContext) {
  const slash = ref.indexOf('/');
  return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
}
function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info') {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}
function measure(content: unknown): number {
  return tokens(typeof content === 'string' ? content : JSON.stringify(content) ?? '');
}
/** Count the actual retained projection, not old raw branches, omissions, or the already summarized prefix. */
function projectionEstimate(entries: SessionEntry[], firstKept: string) {
  const projection = buildSessionProjection(entries);
  let kept = false, retained = 0, before = 0;
  for (const entry of projection.entries) {
    if (entry.sourceEntry.id === firstKept) kept = true;
    for (const message of entry.messages) {
      const size = measure(message);
      before += size;
      if (message.role === 'system' || kept) retained += size;
    }
  }
  if (!kept) throw new Error(`Kept boundary not found in projected branch: ${firstKept}`);
  return { before, retained };
}
/** Map only canonical projected messages; never recover omitted raw text or abandoned branches. */
export function sourceIdentities(entries: SessionEntry[], messages: Message[], firstKept: string): Array<SourceIdentity | undefined> {
  const candidates: Array<{ message: Message; identity: SourceIdentity }> = [];
  for (const entry of buildSessionProjection(entries).entries) {
    if (entry.sourceEntry.id === firstKept) break;
    if (entry.sourceEntry.type === 'compaction') continue;
    entry.messages.forEach((message, index) => {
      if (message.role !== 'system') candidates.push({ message: message as Message,
        identity: { entryId: entry.sourceEntry.id, timestamp: entry.sourceEntry.timestamp, messageIndex: index } });
    });
  }
  let cursor = 0;
  return messages.map(message => {
    const index = candidates.findIndex((candidate, i) => i >= cursor
      && (candidate.message === message || JSON.stringify(candidate.message) === JSON.stringify(message)));
    if (index < 0) return undefined; // Explicitly unmapped, never guess a raw entry ID.
    cursor = index + 1; return candidates[index]!.identity;
  });
}
function providerInput(message: { usage?: { input: number; cacheRead: number; cacheWrite: number } }): number {
  const usage = message.usage;
  if (!usage) return 0;
  const total = usage.input + usage.cacheRead + usage.cacheWrite;
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}
export default function compactionModel(pi: ExtensionAPI, options: { config?: () => Config } = {}) {
  const config = options.config ?? loadConfig;
  pi.on('message_end', async (event, ctx) => {
    // Telemetry only: never change messages, retry, or initiate compaction.
    if (event.message.role !== 'assistant' || !['stop', 'toolUse'].includes(event.message.stopReason)) return;
    const branch = ctx.sessionManager.getBranch();
    const latest = [...branch].reverse().find(e => e.type === 'compaction');
    if (latest?.type !== 'compaction') return;
    const audit = (latest.details as { highFidelity?: { version?: number; observedInputBefore?: number; mainModel?: string; retention?: { ratio?: number } } } | undefined)?.highFidelity;
    if ((audit?.version !== 5 && audit?.version !== 6 && audit?.version !== 7) || branch.some(e => e.type === 'custom' && e.customType === 'high-fidelity-retention-observed'
      && (e.data as { compactionId?: string } | undefined)?.compactionId === latest.id)) return;
    const model = `${event.message.provider}/${event.message.model}`;
    if (audit.mainModel !== model || event.message.timestamp <= new Date(latest.timestamp).getTime()) return;
    const after = providerInput(event.message);
    if (!after) return;
    const before = audit.observedInputBefore ?? 0;
    pi.appendEntry('high-fidelity-retention-observed', { compactionId: latest.id, model, inputAfter: after,
      inputBefore: before || null, observedRatio: before ? after / before : null,
      estimatedRatio: audit.retention?.ratio,
      basis: 'first successful same-model request after compaction vs latest available request input before it; includes cache, excludes output; request hooks/queued inputs may differ' });
  });
  pi.on('session_before_compact', async (event, ctx) => {
    let cfg: Config | undefined;
    let attemptedUsage: Usage | undefined;
    const actualModels: string[] = [];
    try {
      cfg = config();
      if (!cfg.enabled) return undefined;
      if (event.signal.aborted) return { cancel: true };
      const model = modelFor(cfg.model, ctx);
      if (!model) throw new Error(`Compaction model not found: ${cfg.model}`);
      const preparation = event.preparation;
      const projection = projectionEstimate(event.branchEntries, preparation.firstKeptEntryId);
      // Use the conservative larger baseline if Pi's preparation estimate exceeds the projection.
      // Report this explicitly instead of silently mixing before/after accounting methods.
      const planningBefore = Math.max(preparation.tokensBefore, projection.before);
      const budget = plan(planningBefore, projection.retained, ctx.model?.contextWindow ?? model.contextWindow, model, cfg);
      const priorBoundary = [...event.branchEntries].reverse().find(e => e.type === 'compaction');
      const beforeUsage = [...event.branchEntries].reverse().find(e => e.type === 'message'
        && e.message.role === 'assistant' && e.message.provider === ctx.model?.provider && e.message.model === ctx.model?.id
        && (!priorBoundary || e.message.timestamp > new Date(priorBoundary.timestamp).getTime())
        && providerInput(e.message) > 0);
      const observedInputBefore = beforeUsage?.type === 'message' && beforeUsage.message.role === 'assistant' ? providerInput(beforeUsage.message) : undefined;
      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      const identities = sourceIdentities(event.branchEntries, messages as Message[], preparation.firstKeptEntryId);
      const records = serialize(messages as Message[], cfg, identities);
      const previousLedger = priorBoundary?.type === 'compaction'
        ? (priorBoundary.details as { highFidelityLedger?: CriticalRecord[] } | undefined)?.highFidelityLedger : undefined;
      const level = model.reasoning && model.thinkingLevelMap?.[cfg.thinkingLevel] !== null ? cfg.thinkingLevel : 'off';
      notify(ctx, `High-fidelity compaction v7: ${cfg.model}, target ${(cfg.targetRetention * 100).toFixed(0)}% total retention (host estimate); summary budget ~${budget.summaryBudget.toLocaleString()} estimated tokens`);
      const complete: Complete = async request => {
        const response = await ctx.modelRegistry.streamSimple(model, {
          messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }], timestamp: Date.now() }],
        }, {
          signal: event.signal, maxTokens: request.maxTokens, toolChoice: 'none', cacheRetention: 'none',
          // Isolate nested summaries from main-conversation routing/transport state.
          sessionId: randomUUID(),
          ...(level !== 'off' ? { reasoning: level } : {}),
          thinkingBudgets: pi.getSettings().thinkingBudgets,
        }).result();
        attemptedUsage = addUsage(attemptedUsage, response.usage);
        actualModels.push(`${response.provider}/${response.responseModel ?? response.model}`);
        if (response.stopReason !== 'stop' || response.content.some(b => b.type === 'toolCall')) {
          // Never persist an incomplete response as a checkpoint.
          throw new Error(`Summary did not finish safely (${response.stopReason}): ${response.errorMessage ?? ''}`);
        }
        return {
          text: response.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
          usage: response.usage, actualModel: `${response.provider}/${response.responseModel ?? response.model}`,
        };
      };
      const result = await checkpoint({ records, previousSummary: preparation.previousSummary, previousLedger,
        customInstructions: event.customInstructions, plan: budget, config: cfg, signal: event.signal }, complete);
      const modifiedFiles = [...new Set([...preparation.fileOps.edited, ...preparation.fileOps.written])].sort();
      const readFiles = [...preparation.fileOps.read].filter(p => !modifiedFiles.includes(p)).sort();
      // Preserve cumulative lists even though Pi does not merge fromHook file lists itself.
      const previous = [...event.branchEntries].reverse().find(e => e.type === 'compaction');
      if (previous?.type === 'compaction') {
        const details = previous.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
        modifiedFiles.push(...(details?.modifiedFiles ?? []));
        readFiles.push(...(details?.readFiles ?? []));
      }
      const modified = [...new Set(modifiedFiles)].sort();
      const read = [...new Set(readFiles)].filter(p => !modified.includes(p)).sort();
      const audit = { ...result.audit,
        retention: { ...result.audit.retention, basis: planningBefore === projection.before ? result.audit.retention.basis
          : 'Pi preparation upper-bound baseline before, conservative host estimate after; NOT provider tokenization' },
        requestedModel: cfg.model, fallback: false, trigger: event.reason,
        tokensBefore: preparation.tokensBefore,
        estimatedRetention: result.audit.retention.ratio, projectionEstimateBefore: projection.before,
        planningBasis: planningBefore === projection.before ? 'host projection before/after' : 'Pi preparation upper-bound baseline', observedInputBefore,
        mainModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        splitTurn: preparation.isSplitTurn,
        provenance: { mappedMessages: identities.filter(Boolean).length, unmappedMessages: identities.filter(x => !x).length,
          policy: 'canonical projected entries only; message-N labels are explicitly local when unmapped' } };
      notify(ctx, `Checkpoint v7 ready: ${audit.calls} call(s), host-estimated retention ${(audit.estimatedRetention * 100).toFixed(1)}%; provider ratio is not yet measured${audit.retention.floorMet ? '' : `; BELOW 40%: ${audit.retention.shortfallReason}`}`);
      return { compaction: { summary: result.summary, firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore, usage: result.usage,
        details: { readFiles: read, modifiedFiles: modified, highFidelity: audit, highFidelityLedger: result.ledger } } };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      const reason = error instanceof Error ? error.message : String(error);
      const fallback = cfg?.fallback ?? 'cancel';
      pi.appendEntry('high-fidelity-compaction-failure', { requestedModel: cfg?.model,
        fallback: fallback === 'native', reason, trigger: event.reason,
        actualModels: [...new Set(actualModels)], attemptedUsage,
        usageAccounting: 'Failed attempts recorded here only; not included in Pi session usage totals' });
      notify(ctx, `High-fidelity compaction failed: ${reason}. ${fallback === 'native' ? 'Explicit native fallback (lower fidelity).' : 'Cancelled; original history is preserved.'}`, 'warning');
      return fallback === 'native' ? undefined : { cancel: true };
    }
  });

  // Preserve the existing /tree model override; branch summaries are not context-retention compactions.
  pi.on('session_before_tree', async (event, ctx) => {
    const cfg = config();
    if (!cfg.enabled || !cfg.applyToBranchSummaries || !event.preparation.userWantsSummary) return undefined;
    const model = modelFor(cfg.model, ctx);
    if (!model) return undefined;
    const retry = pi.getSettings().retry;
    const result = await generateBranchSummary(event.preparation.entriesToSummarize, {
      model, signal: event.signal, customInstructions: event.preparation.customInstructions,
      replaceInstructions: event.preparation.replaceInstructions,
      reserveTokens: pi.getSettings().branchSummary?.reserveTokens,
      streamFn: (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o),
      retry: { enabled: retry?.enabled ?? true, maxRetries: retry?.maxRetries ?? 3,
        baseDelayMs: retry?.baseDelayMs ?? 2000, maxAgentDelayMs: retry?.maxAgentDelayMs ?? 60000 },
    });
    if (!result.summary || result.error || result.aborted) return undefined;
    return { summary: { summary: result.summary, usage: result.usage,
      details: { readFiles: result.readFiles ?? [], modifiedFiles: result.modifiedFiles ?? [],
        compactionModel: cfg.model, mode: 'native-branch-summary' } } };
  });

  pi.registerCommand('compaction-model', {
    description: 'Show high-fidelity compaction model, retention target and latest audit',
    handler: async (_args, ctx) => {
      try {
        const cfg = config();
        const latest = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'compaction');
        const audit = latest?.type === 'compaction' ? (latest.details as { highFidelity?: unknown } | undefined)?.highFidelity : undefined;
        const observed = [...ctx.sessionManager.getBranch()].reverse().find(e => e.type === 'custom' && e.customType === 'high-fidelity-retention-observed'
          && (e.data as { compactionId?: string } | undefined)?.compactionId === latest?.id);
        notify(ctx, `Loaded compaction plugin v7 · ${cfg.enabled ? cfg.model : 'disabled'} · thinking ${cfg.thinkingLevel} · target retention ${cfg.targetRetention * 100}% (max ${cfg.maxRetention * 100}%)\nConfig: ${CONFIG_FILE}\nLatest audit: ${JSON.stringify(audit ?? 'none')}\nObserved provider retention: ${JSON.stringify(observed?.type === 'custom' ? observed.data : 'not measured')}`);
      } catch (error) { notify(ctx, String(error), 'error'); }
    },
  });
}
