# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kinanty22/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kinanty22/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` reads a patch in one of four
formats — unified diff (often with wrong line numbers), SEARCH/REPLACE blocks,
the V4A patch format, and text-editor tool calls as JSON — finds the lines each
edit names even when the model drifted their whitespace or indentation, and
changes every file or none (atomic: all-or-nothing).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the patch file,
relative to the working directory; when absent or `-`, the patch is read from
standard input. `--format=NAME` reads one format: `unified`,
`search-replace`, `v4a` or `json`; `auto` (the default) detects it.
`--check` does everything but write. `--strict` matches lines exactly
(tier 0 only). Options and `PATCH` may come in any order; `--` ends the
options.

## How it works

- **Matching (three tiers).** An edit's old lines are found at the first tier
  where they occur: tier 0 (exact), tier 1 (trailing spaces/tabs ignored),
  tier 2 (leading and trailing spaces/tabs ignored). At tier 2, added lines
  are re-indented from the patch's indentation to the file's, and context
  lines are written as the file's own lines.
- **Unified diffs.** Sections start at `diff --git` or a bare `---`/`+++`
  pair; creations, deletions and renames/moves are handled, hunks apply in
  order with the nearest occurrence to the (wrong) line number winning, and
  `\ No newline at end of file` controls the final line break.
- **SEARCH/REPLACE.** The path is the nearest non-blank, non-fence line
  before the block (or the previous block's path); an old block that occurs
  more than once at its tier is ambiguous; an empty old block creates a file.
- **V4A.** Add/Delete/Update sections, `*** Move to:`, `@@` anchors with a
  cursor that moves through the file, and `*** End of File` chunks.
- **JSON.** One array of edit objects, or one edit object per line
  (`create`, `str_replace`, `insert`), with CRLF files handled exactly.
- **Atomicity.** Edits apply in order to an in-memory tree; a failed edit
  changes nothing and later edits still run, so every failure is reported;
  when any edit failed, no file is written at all.

Exit codes: 2 for usage / unreadable patch / undetected format / parse
errors (`error: parse <N>`), 1 with one `error: <code> <path>` line per
failed edit, 0 with one `A`/`D`/`M`/`R` line per changed file and
`ok: <n> files`.

## Files

- `main.ts` — the CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner, kept as it is.
- `LICENSE` — MIT.

## License

SPDX-License-Identifier: MIT

---

<sub>Entered on [make.fun](https://make.fun/?ref=mjp730py&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
