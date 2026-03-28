# pi-fzfp

Fuzzy file picker for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Replaces the built-in `@` file autocomplete with fzf-powered fuzzy matching.

## The Problem

Pi's built-in `@file` autocomplete uses `fd` with a regex pattern and substring scoring. Typing `@inxts` won't find `index.ts` because the characters aren't contiguous.

## The Fix

pi-fzfp pipes `fd` output through `fzf --filter` for true subsequence fuzzy matching, scored and sorted by fzf's battle-tested algorithm. No custom scoring — just fzf.

## Install

### Standalone (default editor)

```bash
pi install npm:@burneikis/pi-fzfp
```

### With pi-vim

From the pi-vim README:
```markdown
### With Fuzzy File Picker (optional)

To add the [pi-fzfp](https://github.com/burneikis/pi-fzfp) fuzzy file picker, install it into pi-vim's package directory:

```bash
cd $(npm root -g)/@burneikis/pi-vim
npm install @burneikis/pi-fzfp
```

pi-vim detects pi-fzfp at startup and integrates it automatically.

```

### With another custom editor extension

Add pi-fzfp as a dependency and import the provider wrapper:

```bash
npm install @burneikis/pi-fzfp
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
- [`fzf`](https://github.com/junegunn/fzf) must be installed and on `PATH`

## API

### `wrapWithFuzzyFiles(provider, basePath?)`

Wraps any `AutocompleteProvider` with fzf-powered fuzzy file matching for `@` queries. Returns the provider unchanged if `fd` or `fzf` is not available.

### `FzfFileAutocompleteProvider`

The wrapper class, if you need more control.

## How It Works

1. Intercepts `@` queries in the autocomplete provider
2. Runs `fd` to list all project files (respects `.gitignore`, excludes `.git`)
3. Pipes the file list through `fzf --filter=<query>` for fuzzy matching and scoring
4. Takes the top 20 results (already sorted by fzf's score)
5. Builds autocomplete suggestions with proper `@` prefix and quoting
6. Non-`@` queries pass through to the original provider unchanged
