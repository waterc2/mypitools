// PURPOSE: heal the ctx_* tool whitelist + description compaction patch when a
//          context-mode package update overwrites node_modules. pi's
//          tool-deny.ts can only block calls, not keep unused tool schemas out
//          of the system prompt; the whitelist edit lives in the install tree
//          (mcp-bridge.js) and npm updates wipe it. This extension re-applies
//          the exact same block at load time, so a plugin update is followed by
//          /reload or a restart and the schemas stay trimmed — no manual step.
// INPUT:   ~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js
// MUTATION: rewrites that file (idempotent) when the whitelist marker is
//          missing; logs each attempt to ~/.pi/agent/context-mode-reapply.log.
//          Never writes when already patched; fails open (logs) when the file
//          or the upstream anchor is unexpectedly missing.
// DETERMINISM: byte-for-byte identical block, no randomness, no clock beyond
//          diagnostic timestamps in the log.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BRIDGE = join(homedir(), '.pi', 'agent', 'npm', 'node_modules', 'context-mode', 'build', 'adapters', 'pi', 'mcp-bridge.js');
const LOG = join(homedir(), '.pi', 'agent', 'context-mode-reapply.log');
const MARKER = 'const CTX_DENY_SOURCE';

// Mirror of the v2 patch applied in place to mcp-bridge.js on 2026-10-01, and of
// ~/.pi/agent/reapply-context-mode-whitelist.py BLOCK. Keep all three in sync.
// v1 (2026-09-30) hard-coded a 3-tool whitelist while the routing anchor kept
// advertising ctx_search / ctx_fetch_and_index / ctx_stats / ctx_doctor, which produced
// "Tool ctx_search not found" calls. v2 derives the registered set from the same
// tool-deny.json the anchor filters on, so advertising and callability cannot drift.
const BLOCK = `    const tools = await client.listTools();
    // 2026-10-01 local patch v2 (marker CTX_DENY_SOURCE): the registered ctx_* set is
    // DERIVED from ~/.pi/agent/tool-deny.json — the same file context-mode's routing
    // anchor filters on. Registration and advertising then cannot drift: a ctx_* tool
    // is registered iff it is not denied, so the anchor can never advertise a tool pi
    // cannot call. v1 (hard-coded 3-tool whitelist) did drift: the anchor kept
    // advertising ctx_search / ctx_fetch_and_index / ctx_stats / ctx_doctor, so the
    // model called tools that did not exist ("Tool ctx_search not found").
    // Fail closed: unreadable/corrupt deny file -> only the three core tools.
    const CTX_DENY_SOURCE = (() => {
        const fs = process.getBuiltinModule?.("node:fs");
        const os = process.getBuiltinModule?.("node:os");
        if (!fs || !os?.homedir)
            return null;
        try {
            const path = process.env.TOOL_DENY_CONFIG ?? (os.homedir() + "/.pi/agent/tool-deny.json");
            const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
            const deny = Array.isArray(parsed?.deny) ? parsed.deny : null;
            if (!deny)
                return null;
            return new Set(deny.filter((n) => typeof n === "string" && n.length > 0));
        }
        catch {
            return null;
        }
    })();
    const CTX_CORE_FALLBACK = new Set(["ctx_execute", "ctx_batch_execute", "ctx_execute_file"]);
    const blockedCtxTool = (name) => {
        if (typeof name !== "string" || !name.startsWith("ctx_"))
            return true; // non-ctx MCP names stay unregistered, exactly as in v1
        if (CTX_DENY_SOURCE)
            return CTX_DENY_SOURCE.has(name);
        return !CTX_CORE_FALLBACK.has(name);
    };
    // Compact description for ctx_execute (was a ~3KB essay of WHEN/example text).
    const compactDescription = (tool) => {
        if (tool.name === "ctx_execute") {
            return "Execute script (js/py/sh) in an isolated sandbox. Only what the script prints (console.log/print/echo) enters context; everything else stays out. Pass {language, code, intent?}. Output >5KB is auto-indexed, then retrieved via ctx_search or ctx_batch_execute(query_scope:'global')";
        }
        return tool.description ?? "";
    };
    const registered = [];
    for (const tool of tools) {
        if (blockedCtxTool(tool.name))
            continue; // denied in tool-deny.json: schema stays out of the prompt AND out of the anchor
`.split('\n');

function log(tag: string, msg: string) {
  try {
    appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${msg}\n`);
  } catch {
    /* diagnostic only */
  }
}

function heal() {
  let text: string;
  try {
    text = readFileSync(BRIDGE, 'utf8');
  } catch (err) {
    log('heal', `cannot read bridge (${String(err instanceof Error ? err.message : err)}); leaving unchanged`);
    return;
  }
  if (text.includes(MARKER)) {
    return; // already healed — the common case
  }
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'const tools = await client.listTools();');
  const end = lines.findIndex((l) => l.trim() === 'for (const tool of tools) {', start + 1);
  if (start === -1 || end === -1) {
    log('heal', 'upstream register loop not found — bridge changed shape, manual patch needed');
    return;
  }
  try {
    lines.splice(start, end - start + 1, ...BLOCK); // delete the old tools/registered/for lines (inclusive) and insert ours
    writeFileSync(BRIDGE, lines.join('\n'));
  } catch (err) {
    log('heal', `rewrite failed: ${String(err instanceof Error ? err.message : err)}`);
    return;
  }
  log('heal', `re-applied ctx_* whitelist (was unpatched; spliced lines ${start + 1}..${end})`);
}

heal();

export default function reapplyOnStart(_pi: any) {
  // Re-check at every session start too: a package update between loads leaves
  // the install tree unpatched, and this catches it before the bridge spawns.
  _pi?.on?.('session_start', async () => heal());
}