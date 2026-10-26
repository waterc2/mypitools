#!/usr/bin/env python3
"""Re-apply the ctx_* registration + description compaction patch (v2) to the
context-mode Pi adapter after a package update.

Patches ~/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js so
the registered ctx_* set is DERIVED from ~/.pi/agent/tool-deny.json — the same file
context-mode's routing anchor filters on — and compacts the ctx_execute description.
Registration and advertising therefore cannot drift: a ctx_* tool is registered iff it
is not denied. (v1 hard-coded 3 tools while the anchor still advertised ctx_search /
ctx_fetch_and_index / ctx_stats / ctx_doctor -> "Tool ctx_search not found" calls.)

Idempotent: exits early when the marker (`const CTX_DENY_SOURCE`) is already present.
The source range ends at the original `for (const tool of tools) {` line, which we
keep; the insert block never re-emits it, so repeated runs cannot duplicate the loop
head.
"""
import pathlib, sys

MARKER = "const CTX_DENY_SOURCE"

# Inserted between `const tools = await client.listTools();` and the original
# `for (const tool of tools) {` line. Indentation matches the file (4 spaces).
# Byte-identical to the BLOCK in ~/.pi/agent/extensions/context-mode-reapply.ts.
BLOCK = """    const tools = await client.listTools();
    // 2026-10-01 local patch v2 (marker CTX_DENY_SOURCE): the registered ctx_* set is
    // DERIVED from ~/.pi/agent/tool-deny.json — the same file context-mode's routing
    // anchor filters on. Registration and advertising then cannot drift: a ctx_* tool
    // is registered iff it is not denied, so the anchor can never advertise a tool pi
    // cannot call. v1 (hard-coded 3-tool whitelist) did drift: the anchor kept
    // advertising ctx_search / ctx_fetch_and_index / ctx_stats / ctx_doctor, so the
    // model called tools that did not exist (\"Tool ctx_search not found\").
    // Fail closed: unreadable/corrupt deny file -> only the three core tools.
    const CTX_DENY_SOURCE = (() => {
        const fs = process.getBuiltinModule?.(\"node:fs\");
        const os = process.getBuiltinModule?.(\"node:os\");
        if (!fs || !os?.homedir)
            return null;
        try {
            const path = process.env.TOOL_DENY_CONFIG ?? (os.homedir() + \"/.pi/agent/tool-deny.json\");
            const parsed = JSON.parse(fs.readFileSync(path, \"utf8\"));
            const deny = Array.isArray(parsed?.deny) ? parsed.deny : null;
            if (!deny)
                return null;
            return new Set(deny.filter((n) => typeof n === \"string\" && n.length > 0));
        }
        catch {
            return null;
        }
    })();
    const CTX_CORE_FALLBACK = new Set([\"ctx_execute\", \"ctx_batch_execute\", \"ctx_execute_file\"]);
    const blockedCtxTool = (name) => {
        if (typeof name !== \"string\" || !name.startsWith(\"ctx_\"))
            return true; // non-ctx MCP names stay unregistered, exactly as in v1
        if (CTX_DENY_SOURCE)
            return CTX_DENY_SOURCE.has(name);
        return !CTX_CORE_FALLBACK.has(name);
    };
    // Compact description for ctx_execute (was a ~3KB essay of WHEN/example text).
    const compactDescription = (tool) => {
        if (tool.name === \"ctx_execute\") {
            return \"Execute script (js/py/sh) in an isolated sandbox. Only what the script prints (console.log/print/echo) enters context; everything else stays out. Pass {language, code, intent?}. Output >5KB is auto-indexed, then retrieved via ctx_search or ctx_batch_execute(query_scope:'global')\";
        }
        return tool.description ?? \"\";
    };
    const registered = [];
    for (const tool of tools) {
        if (blockedCtxTool(tool.name))
            continue; // denied in tool-deny.json: schema stays out of the prompt AND out of the anchor"""

F = pathlib.Path.home() / '.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js'
text = F.read_text()
if MARKER in text:
    print('already patched:', F)
    sys.exit(0)

src = text.split('\n')
try:
    start = next(i for i, l in enumerate(src) if l.strip() == 'const tools = await client.listTools();')
    end = next(i for i, l in enumerate(src) if i > start and l.strip() == 'for (const tool of tools) {')
except StopIteration:
    sys.exit('upstream register loop not found - re-derive the patch manually')

src[start:end + 1] = BLOCK.split('\n')   # end inclusive: the original `for` line is replaced by BLOCK's own loop head (keeping the original loop body)
F.write_text('\n'.join(src))
print('patched:', F)