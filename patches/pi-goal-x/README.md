# pi-goal-x — pause-on-create patch (2026-10-13)

## What was changed

Adds a `pauseOnCreate` setting (default **true**) so the guided `/goal` command
**creates the goal paused** instead of running it. The goal is fully persisted to
`.pi/goals/`; nothing executes until the user runs `/goal-resume`. That makes this
workflow possible:

1. `/goal <idea>` — draft and confirm with an expensive/strong model.
2. Goal is written to disk as `paused`; no scheduler kickoff, no continuation.
3. Switch to a cheap execution model.
4. `/goal-resume` — the goal runs from the start of its task tree.

Scope is deliberately narrow: only the guided **`/goal`** path defers execution.
`/sisyphus`, `/goal-direct`, `/sisyphus-direct`, and the agent's `create_goal`
tool still start immediately.

Patched files (all under `extensions/`):

| File | Change |
| --- | --- |
| `goal-record.ts` | `GoalCreationConfig.startPaused?: boolean` |
| `goal-state.ts` | `replaceGoal()` writes `status: "paused"` + `autoContinue: false` + `pauseReason` and a `goal_paused` ledger event; paused notification |
| `goal-drafting.ts` | `/goal` confirmation passes `startPaused` when `pauseOnCreate`; report says execution is deferred |
| `goal-policy.ts` | `buildGoalCreatedReport({ deferred })` opening text |
| `goal-settings.ts` | `pauseOnCreate` schema / parse / resolve (default true) / persist / provenance |
| `goal-commands.ts` | `pauseOnCreate` row + boolean handling in `/goal-settings` |
| `widgets/goal-notifications.ts` | `buildGoalPausedNotification()` |

Why `status: "paused"` rather than an `active` goal with `autoContinue: false`:
`/goal-resume` normally refuses an already-active auto-continue goal
(`validateResumeGoal`) and the scheduler's `resume()` is the only path that resets
the autonomous-run allowance and takes ownership. A paused record goes through
that exact supported path, so resume semantics are unchanged.

## Identity

- pi-goal-x version patched: **0.32.3**
- patch file: `~/.pi/agent/patches/pi-goal-x/pause-on-create.patch`
  (`md5 642dffb5e20e9fee83f10184e9bb5684`, 7 hunks, `git apply -p1` from the
  package root)
- marker injected into the patched source:
  `pi-goal-x-local-patch:pause-on-create`
- per-file md5 — pristine → patched:

  | File | pristine | patched |
  | --- | --- | --- |
  | `goal-commands.ts` | `0489fd429e150427977279da53d0e5d9` | `0a92a8675caf9752fc0152e4c9539379` |
  | `goal-drafting.ts` | `ca040d688af8ee91a8b1e9c4d9814b38` | `036215d70e26c340b133b32a2bb9bde4` |
  | `goal-policy.ts` | `43427732582374fe68a3bd35213c2942` | `cd33904e3f07110dd8c83ea7c3d13de8` |
  | `goal-record.ts` | `1e8ad9073741b76dab83fc3f6dd564f1` | `9d0e01904f5cddd637f3a4c0fc4f9e3c` |
  | `goal-settings.ts` | `01cf9243428e7a32d05ba683b9684197` | `3ec4ce31b9e8fed4b1cce86c484261bb` |
  | `goal-state.ts` | `153c0c5c5cf4bb8c34d4e553b3783a70` | `1703c58245f864b7b79b195b779b11d3` |
  | `widgets/goal-notifications.ts` | `252b85e221efd3129a29c4f7d2fdcaa0` | `1905ee4bbb8bb2527dbc0ace37a2d715` |

The pristine source used to generate the diff was verified byte-identical to the
installed 0.32.3 tree for all unpatched files.

## Detect whether the patch is still in place

```bash
F=~/.pi/agent/npm/node_modules/pi-goal-x/extensions/goal-state.ts
grep -c "pi-goal-x-local-patch:pause-on-create" "$F" # 1 = patched, 0 = lost
```

## Re-apply / revert

```bash
P=~/.pi/agent/patches/pi-goal-x
node "$P/apply.mjs"            # apply if missing (idempotent)
node "$P/apply.mjs" --check    # exit 0 patched, 1 unpatched
node "$P/apply.mjs" --revert   # undo
```

Exit codes: `0` ok, `1` unpatched (`--check`), `2` package not installed,
`3` upstream anchor moved (the patch no longer applies cleanly — re-derive it),
`4` apply command failed. Every run appends to
`~/.pi/agent/pi-goal-x-reapply.log`.

`apply.mjs` prefers `git apply -p1` and falls back to `patch -p1`. Both work
outside a git repository.

## Automatic re-apply after an update

`~/.pi/agent/extensions/pi-goal-x-reapply.ts` runs at extension load and on every
`session_start`, and re-applies the patch when the marker is missing (for example
after `pi update`).

Caveat: packages load **before** user extensions
(`dist/core/package-manager.js` `resolve()` calls `resolvePackageSources` first and
`addAutoDiscoveredResources` last), so pi-goal-x's modules are already imported by
the time the healer runs. A heal repairs the install tree but only takes effect on
the **next** pi start; the extension posts a warning telling you to restart.

## Configuration

`pauseOnCreate` defaults to `true`. Turn it off per project or globally:

- `/goal-settings` → Goal behavior → `pause /goal after creation`
- or write it directly:

  ```json
  { "pauseOnCreate": false }
  ```

  to `~/.pi/agent/pi-goal-x-settings.json` (global) or
  `<project>/.pi/pi-goal-x-settings.json` (project).

## Updating pi-goal-x

When bumping pi-goal-x to a newer version, the patch may or may not still apply:

1. Run `node ~/.pi/agent/patches/pi-goal-x/apply.mjs --check`.
2. If it reports `unpatched` and apply fails with exit code `3`, the upstream
   anchor changed — re-derive the patch:
   - re-apply the edits listed in the table above to the new source,
   - regenerate `pause-on-create.patch` with `git diff` against the pristine
     tarball (`npm pack pi-goal-x@<version>`),
   - update the version, md5 table, and patch md5 in this document.
3. If pi-goal-x ships `pauseOnCreate` upstream, delete this patch and the
   `pi-goal-x-reapply.ts` extension.
