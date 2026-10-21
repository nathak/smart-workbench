# Changelog

All notable changes to SmartWorkbench, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow `.claude-plugin/plugin.json`. Dates are those of the release commit.

## [Unreleased]

### Fixed
- Background work on the live page: a report that quotes whole notices with results of their own no longer lets a quoted one close another task (the block's end is found by counting the blocks it quotes, with the old rule as the fallback), and a duration quoted in a report is no longer read as the notice's; `error`/`timeout` read as failed and `cancelled`/`stopped` as stopped, and `done`/`finished`/`ended` as completed; a notice with an unknown status (a progress report) keeps the work running instead of ending it, and an agent still making calls is judged quiet from its last call, not from its start (it no longer turns to `no end seen` after 30 minutes of work); the end of a background agent's own turn closes it even if its notice never comes; a finished task id that starts again is a new run; an end seen before its start gets the start time; after a rebuild the oldest finished entry goes first and the last state line (goal, limits) is kept; two calls without a tool-use id ending in the same millisecond keep separate entries. The limit bars take their colour from the rounded percent shown, and the reset time follows the replayed clock.
- The import graph resolved `../types` to nothing: declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are now what a specifier names, so a types file shows what imports it (this repo's `types/index.d.ts` had 26 importers shown as 0 and 26 imports counted as not resolved). A tsconfig `paths` pattern without a `*` matches that specifier exactly (`utils` no longer catches `utils-merge`), `paths` without a `baseUrl` no longer turn a bare package name into a project file, `import x from '.'` at the root is its index, and a stylesheet, image or data import is not counted as not resolved. A big file's answer says it was not read (imports unknown) instead of "none"; a test file is shown as in the last run only when its name is a whole word of the command; the Files view redraws when a file is re-pointed at another with the same sizes; a file copied with its size and modification time kept is read again (the cache also compares ctime and inode); a project's slot in the server's graph cache is not dropped while its build runs; calls waiting on one build share the next one; and if the caller's output limit cuts the cache the build is asked again without it.
- A test run whose exit code a pipe or `;` hides (`claude plugin test . 2>&1 | grep -E "^ [0-9]+ (pass|fail)"`) is recorded from its own summary instead of staying `observed`: a failure count above zero fails it, and it passes only when a pass count above zero and a fail count of zero are both seen, from one summary (jest, vitest, pytest, cargo, node:test, bun; node and bun need the two lines within four lines of each other). A summary that reads all passed while the run still fails (vitest `Errors`, a jest coverage threshold) is not a pass. The command may have an edit step before the run (a here-document script, `cp`, `sed -i`, `git add`), set-up (`cd`, `export`), and typecheck, lint or non-test build checks after it; two test runs in one command give no counts and only a failure counts. jest and vitest also need their suite totals (`Test Suites`, `Test Files`) right before the test totals and with no failed suite, so a suite that failed to load is never a pass; output with more than one summary (a recursive run over packages) and a run after a `git` step (its hooks may run tests) can only fail, never pass; a coverage threshold that was not met or a cancelled node test is not a pass. Here-document bodies are no longer read as commands, so a script line starting with `npm test` is not a test run and an odd quote in a script no longer hides the real run after it. A barrier against accidents: a command can print a summary line.
- The Codex cross-review saw an empty diff when the turn's work was already committed: a plain `review` reads the uncommitted changes, and on a clean tree it compares with the default branch, which on `main` is nothing. The final check now names the commit the turn started from and asks for `review --wait --base <commit>`, which a team set to allow Codex runs unasked (only a hex commit id, only for a review). The Codex brief says so too.

### Added
- Background work shows in the live page: a call that returned with work still running (a Bash run sent to the background, a background agent, a workflow, a monitor) opens an entry (`bg.start` feed line), and the task notice that arrives when it ends closes it (`bg.end`, read from the `<task-notification>` prompt: task id, tool-use id, status, summary, duration). A chip in the top bar counts what is running (a click opens the list), the team view's count includes it, and the Agents (team) tab lists each task with its state (running, done, failed, stopped), what it is, when it started and how long it ran. Work whose end notice never arrives shows `no end seen` after 30 minutes and is never shown as finished; an end whose start fell out of the buffer is kept and marked. Feed-only lines (not in the ledger); older pages ignore them.

## [0.22.0] - 2026-10-20

### Changed
- A done condition can carry an expectation of its check (`expect`): at least N tests passed, at most M failed, and/or text the test command must contain. Claude sets it with the `set_condition_expectation` tool (on an unlocked contract, or as a first one on a locked contract's linked condition; never over one the person set, never to replace or remove one on a locked contract). The numbers are read from the run's own summary line (jest, vitest, pytest, cargo, node:test, bun, Maven; the last 40 lines, one plain test run) and kept as counts with one masked line, never the output. An expectation only ever lowers a verdict: a condition is never verified by it, a person's mark and a condition without a check link are left alone. A condition it brings down shows `expected … got …` in the Evidence view of the live page and in the terminal tab, and holds the finish once (not again for the same run, and not on the stop that follows a hold); the person clears it in the Evidence tab. A barrier against accidents: a command can print a summary line.
- A Gradle or Maven test/build run piped into `tail` (or otherwise hiding its exit code) is recorded as passed or failed from its closing `BUILD SUCCESSFUL`/`BUILD FAILED` (Maven `BUILD SUCCESS`/`BUILD FAILURE`, failing test totals) line, instead of staying `observed`; only for a single build run, never for an interrupted or background run, a failure line wins and a success line is ignored when the call ended in error. A barrier against accidents: a command can print such a line.

### Added
- An `import_graph` tool for Claude (read-only): what a JS/TS file imports, what imports it and its tests, one or two steps out, each marked with what the session knows (changed and whether a check followed, pinned, read, the last test run when its command names the test file). Paths only, no contents; the graph is built by `tools/graph-build.mjs` with the Files view's engine and limits (secret, generated, linked and large files are never read), kept 5 seconds and until the next edit; a path outside the project, secret, generated or not JS/TS is refused without echoing it. Not a call the guard classifies, like `propose_contract_change`. The team's explorer and advisor agents may call it too (their tool lists and prompts name it).
- The live page shows the subscription limits (the 5 hour and weekly windows, or a gateway's spend limit) under the context figure: the share used with a bar and the time to the reset, coloured like the context (amber from 75 %, red from 90 %). They come from the engine's own `session.usage()` and `session.measure`, travel as numbers on the `wb` state line (never the turn line or the ledger), and are absent off a subscription.
## [0.21.0] - 2026-10-20

### Added
- A Files view in the live page (key `7`): the import graph of the project's JS/TS sources (`tools/live-graph.mjs`, served at `/graph` by the hub and the single server). Search a file or follow the one the session touched last, see what it imports, what imports it and its tests (one or two steps), with a small drawing on wide screens. Secret and generated files, links and big files are never read, the build is capped and incremental, and nothing is written. Behind a reverse proxy it needs `SWB_LIVE_GRAPH=1`.

## [0.20.0] - 2026-10-19

### Added
- The status window can ask the session to re-read the guard file now (`policy_reload`: the poll that already runs, brought forward; it changes nothing and never drops the rules in force) and edit the templates of the guard file (`policy_set_template`). A template edit writes only the `templates` key; the rules, profile, audit and contract settings are checked to read the same afterwards, and text that looks like a secret is refused. The audit trail and the ledger stay read-only.
- The top-bar model chips of the live page are drawn from the roles of the state line (role and model as set), not fixed to Sonnet, Opus and Haiku.
- The live view follows the Stitch "Cybernetic Console" design: an app shell (sidebar of views with counts, top bar with model chips and the branch, one status strip, a bottom status bar), the flow as a four column pipeline above the timeline in one Live view, an inline icon sprite, KPI tiles with icons, flow boxes as cards with large numerals, call rows with a tool icon, an argument chip and an outcome pill, and an audit trail with a buffer export.
- Live view: Intent and Evidence views (goal card, done conditions, condition matrix with the last check, changed files, verification history), header chips for the goal, done conditions, context pins and guard profile, the guard profile ribbon, the team safety gates, the git branch and short commit (`/info.git`), dropped events, buffer and server round trip in the bottom bar, and the rate against the previous turn. These read two new feed lines, `wb` (contract and guard state) and `evidence` (each check a Bash call ran), both masked and kept out of the ledger.
- A guard question can be answered once (Allow once or Block) from the desktop app and from the live page the app opens itself, besides the question in the session; the first answer counts and a later one in the session is not applied. The answer is a signed `ask_answer` command (the live page's goes through the app's hub, started with `--approve`, which signs it after the app pairs its own window with a one-time code and only when the page is reached by loopback). An answer from outside is refused after a Bash, MCP or file-write call ran since the question, when one was running when it was asked, for an hour after any command other than a plain inspection, after two minutes, while paused and for the always-asked kinds; the screens say why. Calls to the new endpoints and to the pairing file are blocked by the guard. A barrier against accidents, not against a model or program that means to get round it (an earlier process, another session, a reader of the key).
- The desktop app approves or rejects a proposal from Claude (`proposal_decide`, by id); an approval of a change to a locked contract waits for the person's confirmation in the session.
- The desktop app's session window is a ribbon (state, goal, done conditions met, guard profile) over four tabs (Intent, Evidence, Team, Guard) in the same design.
- `desktop/`: an Electron tray app (Korean and English) that keeps the live-view hub running with no session (`live.mjs --hub --keep`), shows it in its own window and sends desktop notifications for a waiting guard question, a quiet session and an ended one; a session joins its hub on its own when the app asks (heartbeat file `~/.claude/smartworkbench-desktop/desktop.json`, read through `tools/desktop-state.mjs` only while fresh) and sends no ask notice of its own while the app shows them.
- The desktop app's session state window (read-only): while the app runs, each session writes a masked snapshot of its contract, team mode, guard and evidence results (`hooks/desktop.ts`, `tools/desktop-snapshot.mjs`), a couple of seconds after a change, only for a session on the app's own hub; files older than a day are removed by the app. Free text goes through the same heuristic secret masking as the live feed, which is not a guarantee.
- `desktop/electron-builder.yml` and `npm run dist` package the app with the hub tools beside it (not built or run on the three platforms yet).
- The desktop app edits a session's contract (goal, constraints, done conditions, non-goals, lock/unlock) through signed command files in `~/.claude/smartworkbench-desktop/inbox/` (HMAC, expiry, target and replay checks in `tools/desktop-channel.mjs`); the session applies them with the panel's own rules and answers in `ack/`. Tool calls touching `smartworkbench-desktop` are blocked by the guard in every profile. The app also sets team mode, role models and efforts, Codex, the guard profile and the pause switch; a change that lowers the guard waits for the person's answer in the session.
- The desktop app edits the shared guard file `.claude/smartworkbench.json`: add an ask or block rule, remove a rule, set or clear the profile (`hooks/policy-edit.ts`). The session reads, edits and writes the file; each edit quotes the file's hash and is refused as stale when it changed, a broken file is never rewritten, unknown keys, indent and line endings are kept, and removing a non-allow rule or lowering the profile is asked in the session. The snapshot carries the hash and each rule (masked) with its place in the file. The write is `tools/desktop-policy-write.mjs` (path fixed to `<root>/.claude/smartworkbench.json`, no links, checked again right before the rename, mode kept); every session looks at the guard file at its next prompt and about every ten seconds, and keeps the rules in force when the file is not valid JSON (half saved).
- `/swb notify on|off`: when the guard asks for your answer, a notification goes through your terminal's notification channel (tool and reason only, never the command); on by default.
- The live view tells a session that stopped beating but whose process still runs (asleep, stopped or busy) from one that ended: its tab says so and has no close button.

### Changed
- The live page's Run & guard and Team mode views follow the Stitch screens: a header card, four tiles, a question card with the tool, summary, category, risk and reason, the audit trail beside the decisions, and role cards (model, effort, runs, calls) with the safety gates and their limits. The state line of the feed also carries the role models, efforts, Codex switches and gate limits.
- The live page shows a Status & settings button in the desktop app's own window; it opens the status window through a preload that offers that one call.
- The live view reads the git branch in the background, so a slow repository no longer holds the server; the first answer after a start has no branch and the next poll has it.
- The desktop app's window loads again with a new pairing code when the hub comes back after a restart, so answering a guard question from the page keeps working.

## [0.19.0] - 2026-10-16

### Added
- `/swb scope session|project`: sessions of a project can keep their own workbench (contract, pins, guard profile, team settings, evidence, changed files, call history) and their own live view (a feed, a process note and a tab per session in `.claude/smartworkbench-live/`), each new session starting from a one-time copy of the project's workbench. On by default (a project can choose `/swb scope project` to keep sharing); a new session starts from the copy most recently saved by another session of the project; the live hub is version 2 and still serves sessions that share the project feed.
- `/swb ledger export-wiki <path>`: the recorded sessions as pages of the llm-wiki (`content/qa-log/<project>/`, its front matter and `[[links]]`, a regenerated Korean block and a `## Notes` that survives), after a preview and a question, files only and no git in the wiki. `"ledger": { "wiki": "off" }` in the guard file forbids it.
- Ledger sharing: `/swb ledger publish` writes a masked summary of a session (never tool input or output) to the repository's `swb-ledger` branch with git plumbing and a temporary index, after a preview and a question; `fetch`, `search` and `forget` complete it, `/swb why` reads teammates' sessions too, and each published session gets a generated note whose human-written `## Notes` survive regeneration. A guard file can forbid it with `"ledger": { "share": "off" }`.

### Security
- Text from shared ledger sessions is cleaned (terminal escapes, invisible and direction characters), its markup made inert, order-like lines marked, and shown in a data frame by `/swb why` and `/swb ledger search`; shared events are checked field by field when read.

## [0.18.0] - 2026-10-14

### Added
- Decision ledger (off until `/swb ledger on`): prompts, answers, tool calls, guard decisions, edits and observed commits are kept as JSON lines inside the git directory, and `/swb why <file[:line]|commit>` shows the turn behind a change through `git blame`. Local only; sharing between people, search and notes come later.

### Fixed
- The side panel's prompt rows no longer squeeze the prompt text to one letter per line.

### Changed
- The README opens with a short overview naming team mode and live monitoring.

## [0.17.1] - 2026-10-14

### Fixed
- The timeline's input and output tabs were empty for ordinary tool calls: the feed now carries each call's input and result text (secrets masked, cut at 2000 characters, none for a call that touches a secrets file, none with `--no-prompts`).

## [0.17.0] - 2026-10-13

### Fixed
- Project files read or written through the engine (guard file, audit log, pins, share and handoff files) and the `git`/`gh` calls are given from the project root too, since relative paths and commands follow the shell's directory.
- Everything the mod keeps or reads by project (the live feed and its process note, the task state, the guard file, the handoff and share files, the live server's folder) used the session's current directory, which follows a shell `cd`. After a command like `cd assets/x && ...` the live feed, prompts, turns and calls were silently not written until the shell came back, and the task contract looked empty. They now use the project root.

### Added
- Guard sensitivity: `/swb guard high|medium|low|off` (and the panel selector; turning it off asks once). `off` lets every call through except what a project rule asked for, changes to the guard file (still asked) and the pause switch; a guard file, a template or a shared task can never set `off`, and a guard file can only raise the level.
- A Codex call that keeps the script path in a variable (`C=.../codex-companion.mjs; node "$C" task ...`) is shown as a Codex run in the live view and counted like the plain form (the guard's decision for it is unchanged).
- One live view for many sessions: sessions on the same port are tabs of one page (project name, badges for new events and for calls waiting on you, ended sessions greyed with a close button, `#s=<session>` in the address). A hub process of its own, started detached by the first session, serves them and ends about 30 s after the last one leaves; sessions register in `~/.claude/smartworkbench-live/<port>/`. Without a port, a port held by another program is skipped (up to 20 further). The hub reads only each project's own feed, never through a link, and ignores registrations that break its rules.
- The live page keeps what it shows when the event stream reconnects until the server's replay arrives (no blank flash), and its "server read N lines, page has M" warning now says what to do.
- The live page keeps what it shows when the event stream reconnects until the server's replay arrives (no blank flash), and its "server read N lines, page has M" warning now says what to do.
- The live server's feed reading is shared code that opens a feed without following links, caps the replay buffer by bytes as well as by lines, and empties it through the opened handle.

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
