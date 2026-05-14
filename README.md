# cmux-amp

> [!IMPORTANT]
> Most of the functionality in this plugin has been ported into the core `cmux` app. Please update your version of `cmux`, try it there, and then only install this plugin if that doesn't work.  

---

[Amp](https://ampcode.com/) plugin for [cmux](https://www.cmux.dev/) that turns
your cmux tab into a live dashboard for the Amp agent.

![cmux 2026-03-16 at 11 25 54](https://github.com/user-attachments/assets/7ccde294-b578-4a73-ab36-ba9b8b223ed4)

Built on the [Amp Plugin API](https://ampcode.com/manual/plugin-api) introduced
with [Amp Neo](https://ampcode.com/news/neo). The plugin API is experimental
and subject to change.

## What you get

- **Live status badge** in the cmux tab switcher — `idle` → `thinking` →
  `running: yarn test` / `editing: cmux-status.ts` / `reading: README.md` →
  `done` / `error` / `interrupted`. Tool labels include the actual shell
  command being run, the file being edited, the search pattern, etc., powered
  by the Neo plugin helpers (`shellCommandFromToolCall`,
  `filesModifiedByToolCall`).
- **Workspace title tracks the Amp thread ID**, including a chain of any
  threads spawned via `handoff`. Manual renames are detected and preserved
  across agent restarts.
- **cmux activity log** entries for prompt received, tool errors, spawned
  threads, and turn outcomes.
- **`cmux_notify` tool** the agent can call to fire a native macOS
  notification when it needs your attention.
- **Command palette actions** under the `cmux:` category:
  - `Rename workspace to thread ID`
  - `Rename workspace…` (prompts for a new title)
  - `Install cmux session restore` (one-click `cmux hooks amp install`)
  - `Clear Amp status`
- **Macro notification** when an agent turn ends with an error.

> Session restore (resume Amp threads after a cmux relaunch) ships natively
> in cmux ≥ 0.64.5 — see
> [manaflow-ai/cmux#3710](https://github.com/manaflow-ai/cmux/pull/3710).
> Run `cmux hooks setup` (or `cmux hooks amp install`) to enable it. If the
> bridge plugin (`~/.config/amp/plugins/cmux-session.ts`) is missing, the
> plugin logs a warning to the cmux activity feed every session and
> additionally fires a native macOS notification at most once per 24h
> (state in `~/.cache/cmux-amp/bridge-warning.json`).

## Installation

1. Symlink (or copy) `plugin/cmux-status.ts` into your plugins directory:
   - System: `~/.config/amp/plugins/cmux-status.ts`
   - Project: `<repo>/.amp/plugins/cmux-status.ts`
2. Launch `amp` from inside a cmux workspace.

> Plugins only work when the Amp CLI is installed via the binary install
> method (not `npm install`). See the
> [Amp Plugin API docs](https://ampcode.com/manual/plugin-api) for details.

## Project Resources

| Resource                         | Description                  |
| -------------------------------- | ---------------------------- |
| [CODEOWNERS](./CODEOWNERS)       | Outlines the project lead(s) |
| [GOVERNANCE.md](./GOVERNANCE.md) | Project governance           |
| [LICENSE](./LICENSE)             | Apache License, Version 2.0  |
