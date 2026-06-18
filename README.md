# pi-fzfp

Fuzzy file picker for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Replaces the built-in `@` file autocomplete with fzf-powered fuzzy matching.

## The Problem

Pi's built-in `@file` autocomplete uses `fd` with a regex pattern and substring scoring. Typing `@inxts` won't find `index.ts` because the characters aren't contiguous.

## The Fix

pi-fzfp pipes `fd` output through `fzf --filter` for true subsequence fuzzy matching, scored and sorted by fzf's battle-tested algorithm.

## Requirements

- [`fd`](https://github.com/sharkdp/fd) must be installed and on `PATH`
- [`fzf`](https://github.com/junegunn/fzf) must be installed and on `PATH`

## Install

```bash
pi install npm:pi-fzfp
```

pi-fzfp stacks an fzf-powered autocomplete provider on top of the built-in
provider via `ctx.ui.addAutocompleteProvider()`. It does not install an editor
component, so it works alongside any custom editor (pi-vim, etc.) with no extra
configuration or coordination — just install both packages.

## How It Works

### Autocomplete

1. Intercepts `@` queries in the autocomplete provider
2. Runs `fd` to list project files (respects `.gitignore`, excludes `.git`)
3. Pipes the file list through `fzf --filter=<query>` for fuzzy matching and scoring
4. Returns all matches sorted by fzf's score (no artificial limit)
5. Builds autocomplete suggestions with proper `@` prefix and quoting
6. Non-`@` queries delegate to the underlying provider unchanged

### Scanning and caching

The `fd` filesystem walk is the expensive part, so pi-fzfp is careful about it:

- **Full-depth scan with a time budget.** Directories are scanned full-depth so
  deeply nested files are always found, with no result cap. A 5s wall-clock
  timeout bounds the walk for pathological trees (e.g. accidentally scanning
  `$HOME` or a network mount); fd is fast enough that this never trips on a
  normal repo (tens of ms even for 100k files).
- **Per-directory cache.** Each directory's listing is cached in memory with a
  30s TTL and reused across keystrokes — repeated typing only re-runs the cheap
  in-memory `fzf --filter`, not `fd`.

Binary lookup (`fd`/`fzf`) uses a pure-filesystem PATH walk (`accessSync`), with
no `which` subprocess.

### Integration

pi-fzfp registers its provider with `ctx.ui.addAutocompleteProvider((current) => ...)`
at `session_start`. pi passes the currently-active provider as `current`, and
pi-fzfp wraps it: `@` queries are matched with fzf, everything else delegates to
`current`. Because this stacks on top of whatever provider is active (built-in or
from a custom editor), no editor detection or event handshake is needed.

## API

### `wrapWithFuzzyFiles(provider, basePath?)`

Wraps any `AutocompleteProvider` with fzf-powered fuzzy file matching for `@` queries. Returns the provider unchanged if `fd` or `fzf` is not available.

### `FzfFileAutocompleteProvider`

The wrapper class, if you need more control.
