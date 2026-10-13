# Changelog

All notable changes to SmartWorkbench, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow `.claude-plugin/plugin.json`. Dates are those of the release commit.

## [Unreleased]

### Security
- A project guard file can only tighten the guard: the stricter of its profile and yours applies, protected checks (secret reads, Codex, remote scripts, MCP deploys) cannot be allowed by a rule, and a rule that asks is still asked under the permissive profile.
- Quoted or escaped flags and words (`rm "-rf"`, `'git' push`, `git -C "a b" push -f`) are read as the shell reads them; scripts piped into a path, `sudo -u` or a bare interpreter are asked; Codex rules hold when `node` has options; `Grep` and `Glob` that reach secrets files are asked; more key and credential files count as secrets; Windows paths and upper-case guard file names are matched.
- "Allow for session" is keyed by category, has no key for a command with a hidden second command (`&`, `$(...)`, backticks), and covers a secrets read only by its whole command.
- Pins must be project paths that are not secrets files, whether typed, from a template or from a shared file; a shared task arrives unlocked and is rebuilt from its known fields.
- A feed that is a link, or a second live view for one project, is refused; the feed is written only while the server's process note is beside it.
- Tokens given as the next word of a flag are masked in the feed and in the audit log; `/swb export` and `/swb share` mask secrets, stay inside the project and never overwrite a named file.

### Fixed
- The mod's own files (the live feed, the audit log) no longer count as work in an infinite loop; no unasked Codex review runs inside a loop; `requireContract` lets the `/swb` commands through; a failed store write cannot let an asked call run; a failure in the records after a call cannot run it twice; subagent calls get no repeat-error nudge; a background advisor opens the design and final-check gates only when its run ends.
- A failing check is no longer hidden by a later passing one of another kind; format-only and no-test runs are not checks; a diff line that is a deleted `-- x` or an added `++ x` is not read as a file header; quoted (non-ASCII) paths in `git diff` are read; snapshots keep only the pinned range; `/swb new`, `load` and `pickup` ask whenever any part of a task exists; open proposals are cleared with the task; `/swb clear` keeps team settings.
- Live feed: a half-written Korean character is no longer damaged (the feed is read as bytes), lines that are not JSON are dropped and counted, a replaced file is read from its start, one look is capped, and a failed write stretch is reported every time.
- Live page: keyboard focus survives redraws, calls cut short by an abort or a new prompt stop waiting, the newest calls of a long turn are drawn first, the page rebuilds without announcing everything as new, and labels follow the language.

## [0.16.1] - 2026-10-13

### Added
- Live view: the server answers `/info` (project, feed path, start time, lines read) and the page shows the project beside the session and warns when the server read many more lines than the page received.

### Fixed
- Live view: calls that follow a finished turn with no new prompt (a background agent finished, a hook resumed the session) start a resumed turn instead of piling into the old one, and a turn with too many calls draws the newest ones with the earlier ones behind a button, so recent advisor and subagent calls are no longer hidden at the far end of a long turn.
- Live view: a failure while reading an event or drawing a view is shown in the status bar and logged to the console instead of being swallowed.

## [0.16.0] - 2026-10-13

### Changed
- Live view rewritten as a monitoring tool: a status bar and six tiles (calls per minute, latency p50 · p95, blocks + errors, asks waiting, context, tokens), a Timeline of turns with nested calls, duration bars, search, an overview strip, a critical path and folded repeats, a Guard tab, an Agents tab, light and dark themes, keyboard shortcuts with a help dialog, addresses that select a call, and screen reader announcements. The Flow picture is kept as a tab; the Log tab is replaced by the Timeline and the Guard tab.

## [0.15.0] - 2026-10-13

### Added
- Live feed: what a subagent answered is recorded on the end of the Agent call that ran it and listed with the prompts per box and link. `--no-prompts` drops these results.
- Live view: `Workflow` calls are shown with the name and description their script states and the script as input; the end of a call is marked as started in the background.

### Changed
- Team tab: the model lists show the version each alias usually stands for (`opus (claude-opus-5-5)`); the hint is a fixed table, since Claude Code decides what an alias resolves to.
- README: command entries for `/swb live`, `/swb loop` and `/swb team codex`, a reference section (environment variables, files written, troubleshooting) and a detailed `SWB_LIVE_HOSTS` section.

## [0.14.0] - 2026-10-12

### Added
- Live view: context gauge with history, tokens per model, and the prompts that crossed each box or link, readable whole.
- Live feed: prompt text up to 2000 characters with secrets masked, Agent briefs and Codex task text, context and tokens on the turn line; `/swb live --no-prompts`.
- Live feed: a write failure is reported once (toast and `/swb live`), `feed.recovered` is written when writes work again, and the page shows when the last event came.
- Infinite loops count a change of the git working tree as work (git's changed paths plus each one's size and modification time), so shell-only edits no longer end the loop.
- Codex image runs: `git status` is compared before and after, and a change outside the picture paths is warned about (never reverted).
- `/swb live` names the server process beside the feed, so a running view can be told from a leftover feed; a second view over a running one is refused.
- Live page: links are keyboard focusable; a stop or prompt that ends a loop travels over drawn links.

### Changed
- Codex detection reads the plugin list from `CLAUDE_CONFIG_DIR` when it is set.
- The advisor gets 35 turns and the explorer 25; both are told to answer before they run out.

### Fixed
- Masking covers every text the feed carries, JSON-quoted names, PGP blocks and more token formats; only the first 8000 characters of a prompt are scanned.

### Security
- The host in the live view's process note is restricted to a plain name, and values handed to `node -e` follow `--`, so a project file cannot pass Node an option.

## [0.13.0] - 2026-10-12

### Added
- Live server: keep-alive comments every 15 s and no-buffering headers, so a reverse proxy neither holds nor closes the stream.
- Live feed: appends through Node when `tee` is missing or fails (Windows).

### Changed
- Dot segments (`a/../b`) are folded out of paths before the guard, project rules and team gates see them.
- Repeated-failure keys use the script and the wrapped command; interrupted runs are ignored in failure counts.
- `sudo`, `env`, `exec` and `time` flags are parsed like `timeout` and `nice` when naming a command.
- The live feed is emptied in place past 8 MB.

### Fixed
- A stopped loop stays stopped; a loop set before pass 1 is cancelled by Esc.
- Real loop and design limits are stated in the prompts.

## [0.12.0] - 2026-10-11

### Added
- Live page: links drawn as an SVG overlay with packets moving along them, per-link counts, an `ask` that waits at the guard.
- Detail drawer, tooltips, pause and resume, replay of the last 20/50/200 events, speed and motion controls, outcome filters.
- Team mode and Codex: `/swb team codex on|off|check|review|rescue`, a Team tab section, consent before any data goes to OpenAI, cross-review before the final check, image generation without a switch in a narrow form.
- Guard: asks before Codex reviews and tasks, always asks for `--write` and `transfer`, and offers no "Allow for session" for them.

### Fixed
- Session-allowed calls are shown as `allow`; an answered ask is counted even without animation; bad feed lines are skipped.

## [0.11.1] - 2026-10-11

### Changed
- Guard: quote masking only for fixed message and search command shapes; fail closed when quoting cannot be trusted; `mkfs` blocked for any target; wrapped and split forms of destructive commands are read.
- Evidence: a check counts only as the command word of a segment; negated, background, `||` and blamed-on-earlier results are unknown.
- Live view: extra `Host` names come only from `SWB_LIVE_HOSTS`, with no built-in domain.

## [0.11.0] - 2026-10-10

### Added
- `/swb live`: a live web view of the request flow (prompts, tool calls, guard decisions, subagents, holds, loop passes, turns) over SSE, with an English/Korean toggle.

### Security
- The page is served with a content security policy, listens on `127.0.0.1` only, and builds every row with `textContent`.

## [0.10.2] - 2026-10-10

### Fixed
- Guard asks only for real `.env` reads and deploy commands.

## [0.10.1] - 2026-10-10

### Fixed
- Loop: Esc ends a loop, the final check runs per pass, and the idle count includes every edit.

## [0.10.0] - 2026-10-10

### Added
- `/swb loop <count|inf> <item>[; <item>...]`: repeat a task, with or without team mode; `inf` ends after 3 passes with no file change.
- Design-first team mode: the advisor produces a `DESIGN` before a big edit, and plans are reviewed before `ExitPlanMode`.

## 0.2.0 to 0.9 (2026-10-07 to 2026-10-09)

Not itemised per version.

### Added
- Team mode: Sonnet builds, Haiku explores, Opus designs and reviews; a Team tab to set each role's model and effort.
- Contract proposals, failed-row actions, the turn result band, goal drafts and `requireContract`.
- Project guard file with team templates, audit log, CI and issue links, MCP tool groups, cross-session sharing.
- "Allow for session" on guard questions.
- Observed file classification and diff-to-evidence links.
- Templates, context sets, line-range and snapshot pins, tool row badges and handoff export.
- Marketplace manifest, install instructions, sample project and permissions document.

## Initial release - 2026-10-07

- The panel with Intent, Context, Run and Evidence tabs, the guard profiles, and the locked contract added to every prompt (P0).
