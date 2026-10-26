# mypitools

My personal extensions, libraries, skills and configs for [Pi](https://github.com/earendil-works/pi-coding-agent) (`~/.pi/agent`).

These are machine-specific, opinionated tools. Read the code before installing; nothing here is a supported product.

## Layout

```
extensions/                 Pi extensions (auto-discovered from ~/.pi/agent/extensions)
  auto-goal-rotator.ts        rotates persistent goals
  cbm-freshness.ts            codebase-memory index freshness checks
  cbmem.ts                    codebase-memory MCP wiring
  codemode-per-model.ts       per-model codemode tool exposure
  compaction-count.ts         compaction counter in the footer/status
  compaction-model.ts         compaction model selection & audit
  context-mode-*.ts           context-mode anchor filter / reapply / tail ordering
  edit-repair.ts              repairs malformed edit tool calls
  hide-unused-slash-commands.ts
  image-read-guard.ts         guards image reads by size/type
  model-carryover.ts          carries model choice across sessions
  output-guard.ts             caps oversized tool output
  pi-goal-x-reapply.ts        re-applies pi-goal-x settings
  slash-command-order.ts
  tool-deny.ts                denylist enforcement for tools
  zcode-env.ts                zcode provider env
lib/high-fidelity-compaction/ High-fidelity compaction engine (see its own README.md)
skills/                       Agent skills (codebase-memory, image-generation)
reapply-context-mode-*.py     Patch re-apply helpers for the context-mode package
AGENTS.md                     Global agent working rules
*.json                        Configs copied from ~/.pi/agent
```

`extensions/*.test.mjs` and `lib/high-fidelity-compaction/*.test.mjs` are the
isolated tests for the corresponding modules.

## Configs included

| File | Purpose |
| --- | --- |
| `mcp.json` | MCP server definitions (codebase-memory `cbm`) |
| `tool-deny.json` | `tool-deny.ts` denylist |
| `pi-goal-x-settings.json` | pi-goal-x package settings |
| `codemode-per-model.json` | `codemode-per-model.ts` settings |

Not included on purpose: `auth.json`, `trust.json`, `models.json` / model
backups, `sessions/`, `npm/`, `_archive/`, caches and logs.

## Installing

Symlink or copy what you want back into `$PI_HOME` (usually `~/.pi/agent`):

```sh
git clone git@github.com:waterc2/mypitools.git ~/mypitools
cp ~/mypitools/extensions/*.ts ~/.pi/agent/extensions/
cp -r ~/mypitools/lib ~/mypitools/skills ~/.pi/agent/
```

Then `/reload` inside Pi. Extension `.test.mjs` files are safe to leave in
place; they are not auto-loaded as extensions but are not needed at runtime
either.

## Caveats

- Several files hardcode `/home/brady/...` paths (tests, `cbmem.ts`'s binary
  path, and commands in `mcp.json`). Adjust them for your machine.
- `extensions/cbmem.ts` and `extensions/image-read-guard.ts` are disabled in my
  `settings.json` (`"-extensions/..."`), i.e. present but not loaded.
- Configs reference models/providers (`mytoken`, `zcode`) that only exist in my
  `models.json`; substitute your own.
- `settings.json` itself is not committed because it mixes package wiring with
  machine state; copy the `packages`/`extensions` entries you need by hand.

## Tests (high-fidelity compaction)

```sh
node --experimental-strip-types --test \
  lib/high-fidelity-compaction/*.test.mjs
```
