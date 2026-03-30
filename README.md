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

### Standalone (default editor)

```bash
pi install npm:@burneikis/pi-fzfp
```

pi-fzfp installs its own `FuzzyFileEditor` as the active editor component.

### With pi-vim (or another compatible custom editor)

Install both as separate pi packages:

```bash
pi install npm:@burneikis/pi-vim
pi install npm:@burneikis/pi-fzfp
```

pi-fzfp detects the other editor at startup via `pi.events` and skips installing its own editor component. It hands off `wrapWithFuzzyFiles` to the other editor instead.

## How It Works

### Autocomplete

1. Intercepts `@` queries in the autocomplete provider
2. Runs `fd` to list all project files (respects `.gitignore`, excludes `.git`)
3. Pipes the file list through `fzf --filter=<query>` for fuzzy matching and scoring
4. Returns all matches sorted by fzf's score (no artificial limit)
5. Builds autocomplete suggestions with proper `@` prefix and quoting
6. Non-`@` queries pass through to the original provider unchanged

### Integration Protocol

pi-fzfp uses `pi.events` to coordinate with custom editor extensions so neither package needs to know about or depend on the other.

**During the factory function** (runs once at load time):
- Emits `"pi-fzfp:provider"` with `wrapWithFuzzyFiles` — caught by any editor extension that loaded before pi-fzfp and is already listening.

**During `session_start`** (runs after all extension factories have completed):
- Re-emits `"pi-fzfp:provider"` — caught by editor extensions that loaded after pi-fzfp and set up their listener during their own factory.
- Emits `"pi-fzfp:check-editor"` with an ack callback — if any other extension acks, pi-fzfp skips `setEditorComponent` and lets that extension own the editor.

This double-emit pattern means the load order of pi-fzfp relative to another editor extension doesn't matter.

### Implementing the protocol in your editor extension

Register both listeners during your factory (before `session_start`), so they are always in place when pi-fzfp's `session_start` fires:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";

export default function (pi: ExtensionAPI) {
  let wrapAutocomplete: ((provider: AutocompleteProvider) => AutocompleteProvider) | undefined;

  // Prevent pi-fzfp from setting its own editor component.
  pi.events.on("pi-fzfp:check-editor", (ack: () => void) => { ack(); });

  // Receive the provider — pi-fzfp emits this from both its factory and its
  // session_start to cover both possible load orderings.
  pi.events.on("pi-fzfp:provider", (fn: (provider: AutocompleteProvider) => AutocompleteProvider) => {
    wrapAutocomplete = fn;
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new MyEditor(tui, theme, keybindings, wrapAutocomplete)
    );
  });
}
```

Apply `wrapAutocomplete` in your editor's `setAutocompleteProvider`:

```typescript
override setAutocompleteProvider(provider: AutocompleteProvider): void {
  super.setAutocompleteProvider(this.wrapAutocomplete ? this.wrapAutocomplete(provider) : provider);
}
```

## API

### `wrapWithFuzzyFiles(provider, basePath?)`

Wraps any `AutocompleteProvider` with fzf-powered fuzzy file matching for `@` queries. Returns the provider unchanged if `fd` or `fzf` is not available.

### `FzfFileAutocompleteProvider`

The wrapper class, if you need more control.
