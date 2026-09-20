# Tokeniser

VS Code extension that makes Claude Code usage visible and comprehensible — from documented, local sources only.

**Status:** early stage. All design decisions live in [docs/tokeniser-sammanfattning.md](docs/tokeniser-sammanfattning.md). The clickable mockup in [docs/skiss/tokeniser-skiss.html](docs/skiss/tokeniser-skiss.html) is to be approved before the view is built.

## Development

Requires Node 24.13 or later and VS Code with WSL.

```sh
npm install
npm run build          # builds dist/extension.js and dist/collector.js with esbuild
npm run watch          # rebuilds on change
npm run typecheck
npm test               # unit tests and tests of the built collector
npm run test:integration  # launches VS Code 1.137.0 with synthetic data; needs a display (CI uses xvfb)
```

Launch the extension in a development instance with F5 ("Run extension").

CI on GitHub (`.github/workflows/ci.yml`) runs type checking, unit tests, end-to-end tests and the VS Code integration tests on every push to `main` and every pull request. The workflow has read-only permission, no secrets, and actions pinned to exact commits.

## Install

```sh
npm run package                              # builds tokeniser.vsix with only what the extension needs
code --install-extension tokeniser.vsix      # from a WSL terminal: installs into the VS Code server in WSL
code --uninstall-extension lullo.tokeniser   # removes it again
```

Reload the VS Code window after installing. The collector is still connected with `npm run connect`. Which files the VSIX may contain is governed by the allow-list in `.vscodeignore`, and CI verifies the contents.

## The collector

Claude Code runs the collector as a status line. It validates the JSON data, prints a short line in the terminal (`5h 64% · w 31% · ctx 21%`) and appends a line to `~/.tokeniser/events/YYYY-MM.jsonl` when the metrics have changed. Conversation content, `session_name`, `transcript_path` and `prompt_id` are never stored.

Until the extension has a connect button of its own, there is a development script. It first shows a plan and the plan's hash. `--apply` requires exactly that hash, which binds the approval to every path, permission, file hash and diff line. If anything changes before the plan is applied, the run aborts without changes.

```sh
npm run connect                                   # shows the plan and its hash, changes nothing
npm run connect -- --no-line                      # same plan, but without a line in the terminal status line
npm run connect -- --apply=<hash>                 # applies exactly that plan
npm run connect -- --disconnect                   # shows the disconnection plan
npm run connect -- --disconnect --apply=<hash>    # restores settings.json and removes the collector
```

Protections in brief:
- The entire directory chain to `~/.tokeniser` and `~/.claude/settings.json` is checked with `lstat`: no symbolic links, correct owner, not writable by anyone else. Files are opened with `O_NOFOLLOW` and then checked on the opened file, including the hard link count.
- `settings.json` is written atomically via a temporary file, and aborts if the contents have changed since the plan was made.
- Disconnection never takes paths from `connection.json`.
- The collector runs with `env -i` and Node's permission model: it may read its own file and read and write in `events/` and `state/`. This is defence in depth, not a sandbox. The permission model does not, for example, stop networking in Node 24.
- Every promise and what enforces it is documented in [docs/insamlarens-sakerhetskontrakt.md](docs/insamlarens-sakerhetskontrakt.md).

## Indexing

`npm run index` reads new events from `~/.tokeniser/events/` into `~/.tokeniser/index.sqlite` and prints a summary. The JSONL files are the source of truth. The index can always be rebuilt with `npm run index -- --rebuild`.

- Only one process indexes at a time, via the lock file `index.lock`. Every event is unique per file and byte offset, so not even concurrent readers without a lock produce duplicates.
- Read position is stored per file. A partial line waits until it is complete, and a replaced or truncated file is read again from the start.
- Lines are treated as untrusted data and validated again. Text containing control characters is not stored.
- Projects are identified by the repository where there is one, otherwise by the directory. If a directory later gains a repository identity, the history is merged.

## In VS Code

Launch a development instance with F5 ("Run extension"). The extension runs inside WSL and reads `~/.tokeniser`.

- **The status line** shows consumption, for example `5h 64% · w 31%`. Choose the mode with `tokeniser.statusBar.mode`: both limits, 5 h only, week only, nearest limit, or context. The warning colour starts at `tokeniser.statusBar.warningAt` (80) and the error colour at `tokeniser.statusBar.errorAt` (95).
- **Data state:** a clock appears when the latest value is older than 5 minutes, `↺` when the limit has reset, and `–` when the value is missing. A missing value is never shown as 0.
- **The quick card** appears on hover over the status line. It has rings for the limits, time until reset, the context in the window's project, other active sessions, a forecast labelled as an estimate, and the "Open Tokeniser" link.
- **The view** sits in the bottom panel next to the Terminal. Click Tokeniser in the status line to show or hide it. It has limit rings, forecasts, a context bar, session tokens, a 7-day curve, today's projects, and suggestions with a copy button. Tokens per day and per session are estimates.
- **Right side panel:** right-click the Tokeniser tab and choose to move it to the secondary side bar. The layout adapts to the width.
- **The large-context suggestion** appears at `tokeniser.suggestions.contextTokens` (200,000) or `tokeniser.suggestions.contextPercent` (60), whichever comes first.
- **Health** sits at the top of the view and is expanded only when something is wrong. It shows:
  - the latest data
  - fields that are missing and why
  - whether the collector has been modified
  - whether Tokeniser's directories are protected
  - whether the Node binary and `/usr/bin/env` exist, are executable and are protected
  - whether another setting overrides or disables the status line

  On a warning, the status line gets an icon and the quick card gets a row with the "Show health" link. Settings files are read for inspection only, and `~/.claude.json` is never read, because it contains the login.
- **Data** sits last in the view. The row shows the event count and size, followed by Export…, Delete… and Settings. The same actions are in the command palette.
  - **Export** saves all events as JSONL wherever you choose. The notification afterwards states what the file contains and who can read it.
  - **Delete** is confirmed in VS Code's dialog. When Tokeniser is connected, collected data is removed; otherwise all of `~/.tokeniser`. Only files Tokeniser created are removed.
- One window at a time indexes new events. Other windows only read.

F5 requires the `tokeniser` directory to be open as the root folder in VS Code.

## Structure

```
src/extension.ts      VS Code entry point: the status line and the quick card
src/status/           status line text, data state, forecast and quick card
src/view/             the view: data, model, suggestions, security rules and the webview in src/view/webview/
src/collector/        the collector: validation, status line and storage
src/connect/          plan, plan hash, diff and rollback for settings.json
src/index/            indexing into SQLite: validation, project identity, locking and read position
src/data/             export, deletion and the text in their dialogs
src/health/           the health check: facts from files, settings and the index, and the rows in the view
src/secure/           controlled file handling: directory chain, owner, permissions, atomic writes
scripts/connect.ts    development script for connecting
scripts/index.ts      development script for indexing
test/unit/            unit tests
test/e2e/             tests of the built collector, connection and indexing
test/fixtures/        examples from the documentation and anonymised real data
docs/                 decisions, mockups and the security contract
```
