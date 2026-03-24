# pi-fzfp

Fuzzy file picker for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Replaces the built-in `@` file autocomplete with true subsequence fuzzy matching.

## The Problem

Pi's built-in `@file` autocomplete uses `fd` with a regex pattern and substring scoring. Typing `@apbanscocots` won't find `applesbannanascoconuts` because the characters aren't contiguous.

## The Fix

pi-fzfp wraps the autocomplete provider so that `@` queries use pi-tui's `fuzzyFilter`, which matches all query characters **in order** (not necessarily consecutive). Typing `@apbanscocots` now matches `applesbannanascoconuts`. Space-separated tokens work too: `@ap ban coc`.

## Install

### Standalone (default editor)

```bash
pi install git:github.com/aburneikis/pi-fzfp
```

Or clone manually:

```bash
git clone https://github.com/aburneikis/pi-fzfp ~/.pi/agent/extensions/pi-fzfp
```

### With pi-vim

Use the [`fzfp` branch of pi-vim](https://github.com/aburneikis/pi-vim/tree/fzfp), which includes pi-fzfp as a dependency:

```bash
cd ~/.pi/agent/extensions/pi-vim
git checkout fzfp
npm install
```

**Do not install pi-fzfp separately when using the pi-vim fzfp branch** — the fuzzy matching is built in.

### With another custom editor extension

Add pi-fzfp as a dependency and import the provider wrapper:

```bash
npm install github:aburneikis/pi-fzfp
```

Then in your custom editor:

```typescript
import { wrapWithFuzzyFiles } from "pi-fzfp/provider";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";

class MyEditor extends CustomEditor {
  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
  }
}
```

## Requirements

- [`fd`](https://github.com/sharkdp/fd) must be installed and on `PATH`

## API

### `wrapWithFuzzyFiles(provider, basePath?)`

Wraps any `AutocompleteProvider` with fuzzy file matching for `@` queries. Returns the provider unchanged if `fd` is not available.

### `FuzzyFileAutocompleteProvider`

The wrapper class, if you need more control.

## How It Works

1. Intercepts `@` queries in the autocomplete provider
2. Runs `fd` with no query filter to list all project files (up to 5000, respects `.gitignore`)
3. Applies `fuzzyFilter` from `@mariozechner/pi-tui` for true subsequence matching
4. Returns the top 20 results sorted by match quality
5. Non-`@` queries (slash commands, tab path completion) pass through unchanged
