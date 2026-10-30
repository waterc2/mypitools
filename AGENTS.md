# Agent working rules

Cross-project workflow lives here. Repository instructions add project constraints, commands and guide mappings rather than copying this policy.

## Execution

- Stay in scope; consult the relevant project guide before changing its area. Skills/guides are on-demand: reuse unchanged content already in context, reloading only after changes or context loss.
- Call available tools directly for reads, searches and edits. Independent calls may run in parallel; sequential direct calls are fine. Prefer deterministic scripts for mechanical derivations, not as a replacement for source lookup tools.
- Never treat truncated/paginated output as complete data. Continue, narrow the query, or parse the full file in an execution tool and return only needed fields.
- Verify persisted edits with a diff or checksum; preserve pre-existing changes.
- After two failed attempts at the same edit/command without new evidence, inspect the failure and change approach or report the blocker; do not expand scope.

## Code retrieval

- Follow the declared tools' routing and schemas; do not duplicate them in project rules. If `code_*` is absent, use available native tools. No mandatory tool chain or usage quota.
- Start discovery with an identifier or short domain keywords; constrain paths only with evidence. Inspect results before fallback, reuse relevant evidence, and never infer absence from a miss or partial window. Tests may be searched/read directly.
- Read current source before editing. Index locations/signatures and search previews may lag; static graph edges do not prove runtime bindings or all references. Continue partial reads rather than assembling bodies from repeated context greps.
- Discover advanced tools only when needed and wait for their current declarations; do not guess schemas, reuse undeclared historical tools or enable hidden tools. Report graph gaps honestly.
- `bash` is for git/build/tests; `find`/`ls` locate paths. Do not use shell grep/sed/cat loops or scripts to retrieve source.

## Verification

- Select the smallest sufficient checks from this task's changes, not the whole dirty tree. Use source/dependencies and relevant graph impact where useful; cover affected boundaries without an arbitrary file cap. Review shared setup, dynamic loading, fixtures, DB/content and broad contracts when selecting tests. Before execution, name affected behavior and exact commands/test files; honor stricter project rules.
- Full/broad suites, domain-wide checks, unfiltered watch and E2E require explicit approval, including through wrappers. Completion/commit preparation, no matches and failures never authorize broader checks. If necessary scope is broad or unclear, explain and ask.
- Batch coherent edits, then one final targeted pass. Intermediate checks need a concrete diagnostic question; do not rerun for status updates or commit preparation. Reuse passes only while relevant source, tests, fixtures, config, dependencies and generated inputs are unchanged; unrelated docs/status changes do not invalidate them.
- Diagnose failures before rerunning only failing/newly affected scope after a fix. After two consecutive failures in that scope, stop automatic retries; proceed only with new evidence or user direction.
- Docs/comments/copy-only translations/static styling or assets need relevant diff, references or visual checks, not runtime suites, unless a project-specific check applies.
- Preserve assertions, isolation, timeouts and safety gates. Record command, scope and result; report unrun checks/risks, never weaken checks or imply broader verification.
