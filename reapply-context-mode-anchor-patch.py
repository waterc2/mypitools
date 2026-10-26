#!/usr/bin/env python3
"""Re-apply the context-mode routing-anchor patch after a package update.

Patches the Pi adapter so the per-turn routing anchor only advertises tools the model
can actually call (see ~/.pi/agent/context-mode-anchor-patch.md).
Idempotent: exits early if the patch marker is already present.
"""
import pathlib, sys

BLOCK = '            // 2026-09-27 local patch (see ~/.pi/agent/context-mode-anchor-patch.md):\n            // only route to tools the model can actually call. Two signals are needed,\n            // because right after a reload pi re-activates every tool and this handler\n            // may run BEFORE the tool-deny extension re-filters them.\n            const anchorHidden = (() => {\n                const hidden = new Set();\n                try {\n                    const fs = process.getBuiltinModule?.(\'node:fs\');\n                    const os = process.getBuiltinModule?.(\'node:os\');\n                    if (!fs || !os)\n                        return hidden;\n                    const file = process.env?.TOOL_DENY_CONFIG || os.homedir() + \'/.pi/agent/tool-deny.json\';\n                    for (const n of JSON.parse(fs.readFileSync(file, \'utf8\'))?.deny ?? [])\n                        if (typeof n === \'string\')\n                            hidden.add(n);\n                }\n                catch { /* missing or corrupt deny file -> nothing hidden (fail open) */ }\n                return hidden;\n            })();\n            const liveTools = (() => {\n                try {\n                    const names = pi.getActiveTools();\n                    return Array.isArray(names) && names.length > 0 ? new Set(names) : null;\n                }\n                catch {\n                    return null; // API not ready -> no whitelist (fail open)\n                }\n            })();\n            const visible = (name) => !anchorHidden.has(name) && (!liveTools || liveTools.has(name));\n            const order = ["ctx_batch_execute", "ctx_execute", "ctx_execute_file", "ctx_search"].filter(visible);\n            const routes = [\n                ["ctx_execute_file", "Read/edit files → ctx_execute_file"],\n                ["ctx_batch_execute", "Multi-command research → ctx_batch_execute"],\n                ["ctx_fetch_and_index", "Web pages → ctx_fetch_and_index then ctx_search"],\n                ["ctx_index", "Index docs → ctx_index"],\n                ["ctx_stats", "Stats → ctx_stats"],\n                ["ctx_doctor", "Doctor → ctx_doctor"],\n                ["ctx_upgrade", "Upgrade → ctx_upgrade"],\n                ["ctx_purge", "Purge → ctx_purge"],\n            ]\n                .filter(([name]) => visible(name))\n                .map(([, text]) => text);\n            const anchorParts = [];\n            if (order.length)\n                anchorParts.push("Hierarchy: " + order.join(" > "));\n            if (routes.length)\n                anchorParts.push(routes.join(". "));\n            if (anchorParts.length)\n                parts.push("context-mode active. " + anchorParts.join(". ") + ".");'

F = pathlib.Path.home() / '.pi/agent/npm/node_modules/context-mode/build/adapters/pi/extension.js'
text = F.read_text()
if '2026-09-27 local patch' in text:
    print('already patched:', F)
    sys.exit(0)
src = text.split('\n')
try:
    start = next(i for i, l in enumerate(src) if 'parts.push("context-mode active. Hierarchy:' in l)
    end = next(i for i, l in enumerate(src) if i >= start and 'ctx_purge.\");' in l)
except StopIteration:
    sys.exit('upstream anchor text not found - re-derive the patch manually (see the .md note)')
src[start:end + 1] = BLOCK.split('\n')
F.write_text('\n'.join(src))
print('patched:', F)
