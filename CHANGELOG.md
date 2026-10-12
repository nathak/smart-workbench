# Changelog

All notable changes to SmartWorkbench, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow `.claude-plugin/plugin.json`. Dates are those of the release commit.

## [Unreleased]

### Added
- Live feed: what a subagent answered is recorded on the end of the Agent call that ran it and listed with the prompts per box and link. `--no-prompts` drops these results.

- Live view: `Workflow` calls are shown with the name and description their script states and the script as input; the end of a call is marked as started in the background.

### Changed
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

[Unreleased]: https://github.com/nathak/smart-workbench/compare/c71dc50...HEAD
