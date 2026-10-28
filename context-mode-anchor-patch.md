# context-mode Pi adapter — routing-anchor patch (2026-09-27)

## What was changed
`/home/brady/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js` — entry point confirmed via the package's `pi.extensions` field, so this is
the file Pi actually loads.

The `before_agent_start` handler injects a routing anchor into Pi's system prompt on
**every turn**. The original text was hard-coded and advertised *all* ctx_* tools,
including ones denied through `~/.pi/agent/extensions/tool-deny.ts`
(`ctx_index`, `ctx_upgrade`, `ctx_purge`), so the model was routed to tools it cannot
call.

Why two filtering signals are required: on `/reload` pi **re-activates every tool**
(the session transcript records `toolsAdded: [ctx_index, ctx_upgrade, ctx_purge,
ctx_insight]`), and this handler may run *before* the tool-deny extension re-filters
them. `pi.getActiveTools()` alone therefore still contains the denied tools on the
first turn after a reload. The patch additionally reads the deny list directly:

- `anchorHidden` — `$TOOL_DENY_CONFIG` or `~/.pi/agent/tool-deny.json` `deny[]`
  (ordering-independent, catches the post-reload turn)
- `liveTools` — `pi.getActiveTools()`, used as a whitelist when available
  (catches deactivation that is not in the deny file)
- a tool is routed to only when it is in neither exclusion
- fail-open: missing/corrupt deny file, or `getActiveTools()` throwing / returning
  `undefined` / `[]`, leaves the corresponding signal disabled — never silently drops
  the whole anchor

- context-mode version patched: **1.0.169**
- original file md5: `419111aaf23692d0b028d92aa2fea2b4` (backup moved 2026-10-01 to `/home/brady/.pi/agent/_archive/2026-10-01-cleanup/agent/context-mode-pi-extension.backup-20260927.js`)
- patched file md5: `07ef80119e518c7b772925058dd15729`
- effect: with every tool active and an empty deny list the output is **byte-identical**
  to the original sentence; with the current deny list the anchor shrinks by 66 B
  (~18 tok) per turn.

## Detect whether the patch is still in place
```bash
F=~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js
grep -c "2026-09-27 local patch" "$F"   # 1 = patched, 0 = lost (a package update replaced the file)
```

## Re-apply after a package update
```bash
python3 ~/.pi/agent/reapply-context-mode-anchor-patch.py
```
The script replaces the `parts.push("context-mode active. Hierarchy: ...")` statement
(4 upstream source lines, ending with `Purge -> ctx_purge.");`) with the block below,
and is idempotent. The patched block is:

```javascript
            // 2026-09-27 local patch (see ~/.pi/agent/context-mode-anchor-patch.md):
            // only route to tools the model can actually call. Two signals are needed,
            // because right after a reload pi re-activates every tool and this handler
            // may run BEFORE the tool-deny extension re-filters them.
            const anchorHidden = (() => {
                const hidden = new Set();
                try {
                    const fs = process.getBuiltinModule?.('node:fs');
                    const os = process.getBuiltinModule?.('node:os');
                    if (!fs || !os)
                        return hidden;
                    const file = process.env?.TOOL_DENY_CONFIG || os.homedir() + '/.pi/agent/tool-deny.json';
                    for (const n of JSON.parse(fs.readFileSync(file, 'utf8'))?.deny ?? [])
                        if (typeof n === 'string')
                            hidden.add(n);
                }
                catch { /* missing or corrupt deny file -> nothing hidden (fail open) */ }
                return hidden;
            })();
            const liveTools = (() => {
                try {
                    const names = pi.getActiveTools();
                    return Array.isArray(names) && names.length > 0 ? new Set(names) : null;
                }
                catch {
                    return null; // API not ready -> no whitelist (fail open)
                }
            })();
            const visible = (name) => !anchorHidden.has(name) && (!liveTools || liveTools.has(name));
            const order = ["ctx_batch_execute", "ctx_execute", "ctx_execute_file", "ctx_search"].filter(visible);
            const routes = [
                ["ctx_execute_file", "Read/edit files → ctx_execute_file"],
                ["ctx_batch_execute", "Multi-command research → ctx_batch_execute"],
                ["ctx_fetch_and_index", "Web pages → ctx_fetch_and_index then ctx_search"],
                ["ctx_index", "Index docs → ctx_index"],
                ["ctx_stats", "Stats → ctx_stats"],
                ["ctx_doctor", "Doctor → ctx_doctor"],
                ["ctx_upgrade", "Upgrade → ctx_upgrade"],
                ["ctx_purge", "Purge → ctx_purge"],
            ]
                .filter(([name]) => visible(name))
                .map(([, text]) => text);
            const anchorParts = [];
            if (order.length)
                anchorParts.push("Hierarchy: " + order.join(" > "));
            if (routes.length)
                anchorParts.push(routes.join(". "));
            if (anchorParts.length)
                parts.push("context-mode active. " + anchorParts.join(". ") + ".");
```

## Verify
```bash
F=~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js
cp "$F" /tmp/check.mjs && node --check /tmp/check.mjs && echo "syntax OK"
python3 - "$F" <<'PYEOF'
import sys
src = open(sys.argv[1], encoding='utf-8').read().split('\n')
s = next(i for i, l in enumerate(src) if '2026-09-27 local patch' in l)
e = next(i for i, l in enumerate(src) if i > s and l.strip().startswith('// Pi-3'))
open('/tmp/anchor-block.js', 'w').write('\n'.join(src[s:e]))
PYEOF
node -e "
const fs = require('fs');
const block = fs.readFileSync('/tmp/anchor-block.js', 'utf8');
const run = (o) => {
  process.env.TOOL_DENY_CONFIG = o.denyFile;
  const p = ['B'];
  const pi = { getActiveTools: () => { if (o.throws) throw 0; return o.active; } };
  new Function('pi', 'parts', 'existingPrompt', block)(pi, p, 'B');
  return p.filter(x => x !== 'B').join('');
};
const ALL = ['ctx_batch_execute','ctx_execute','ctx_execute_file','ctx_search','ctx_fetch_and_index','ctx_index','ctx_stats','ctx_doctor','ctx_upgrade','ctx_purge'];
const D = '/tmp/denytest/deny.json';   // {"deny":["ctx_index","ctx_upgrade","ctx_purge"]}
const bad = (s) => /ctx_index|ctx_upgrade|ctx_purge/.test(s);
console.log('reload turn (all active) :', !bad(run({ active: ALL, denyFile: D })));
console.log('normal turn              :', !bad(run({ active: ALL.filter(n => !bad(n)), denyFile: D })));
console.log('getActiveTools throws    :', !bad(run({ active: ALL, throws: 1, denyFile: D })));
console.log('no deny file (fail open) :', run({ active: ALL, denyFile: '/tmp/denytest/nope.json' }).includes('ctx_purge'));
"
```
Expected: `syntax OK` and four `true`s.

## Rollback
```bash
cp ~/.pi/agent/_archive/2026-10-01-cleanup/agent/context-mode-pi-extension.backup-20260927.js \
   ~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js
```

## Alternative (bigger saving)
Deleting the whole anchor statement saves the full ~360 B (~100 tok) per turn instead
of 66 B, at the cost of losing the "which ctx_* tool for which scenario" routing hint.

---
# Follow-up patch v2 (2026-10-01): registration derived from the deny list

The 2026-09-30 whitelist (`const ALLOWED_CTX_TOOLS = new Set([...3 tools])`) and this
anchor filter disagreed: the filter hid only `tool-deny.json` names, so the anchor kept
advertising `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_doctor` while the
bridge registered only three tools. Observed failure: `Tool ctx_search not found`
(2026-10-01T18:57:59Z), plus 8 similar refused calls before the uninstall.

`mcp-bridge.js` now reads the same `tool-deny.json` the anchor filters on and registers
every `ctx_*` tool **not** denied (marker `const CTX_DENY_SOURCE`; fail closed to the
three core tools when the file is unreadable). `tool-deny.json` is therefore the single
source of truth: one edit moves a tool in and out of the tool list, the prompt anchor,
and the execution guard at the same time.

Current state: `deny = [ctx_insight, ctx_upgrade, ctx_purge, ctx_index, ctx_stats,
ctx_doctor]` → registered = `ctx_execute, ctx_execute_file, ctx_batch_execute,
ctx_search, ctx_fetch_and_index` = exactly what the anchor advertises.

Mirrors kept in sync (all three produce the identical block):
- `npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js` (applied in place)
- `extensions/context-mode-reapply.ts` (re-applies after an npm update)
- `reapply-context-mode-whitelist.py`

Invariant test: `node ~/.pi/agent/extensions/anchor-consistency.test.mjs` — evaluates the
shipped bridge snippet, recomputes the anchor's advertised set from the real
`extension.js` arrays, and asserts advertised ⊆ registered across bridge, anchor,
context-mode's own result hints, and both project `AGENTS.md` files.
