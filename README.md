# pi-fzfp

Fuzzy file picker for [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Replaces the built-in `@` file autocomplete with weighted dual-key fuzzy matching.

## The Problem

Pi's built-in `@file` autocomplete uses `fd` with a regex pattern and substring scoring. Typing `@inxts` won't find `index.ts` because the characters aren't contiguous.

## The Fix

pi-fzfp wraps the autocomplete provider so that `@` queries use pi-tui's `fuzzyMatch` (true subsequence matching) with a **weighted dual-key scoring** strategy:

- **Basename** (weight: 2) — filename matches are scored 2× higher than path matches
- **Full path** (weight: 1) — still searchable, but lower priority
- **Suffix alignment bonus** — when the end of your query matches the end of the filename, each aligned character adds a score bonus. So `@acts` prefers `abct.ts` over `abct.scss` because `ts` aligns with the extension (2 chars) vs only `s` (1 char).

### Additional scoring features

- **Path prefix pre-filtering**: If your query contains `/` and is longer than 2 chars, only files whose path starts with the query prefix (up to the last `/`) are searched
- **Test file penalty**: Files with "test" in their path are penalized slightly as a tiebreaker
- **True subsequence matching**: Characters must appear in order but don't need to be consecutive

## Install

### Standalone (default editor)

```bash
pi install git:github.com/burneikis/pi-fzfp
```

Or clone manually:

```bash
git clone https://github.com/burneikis/pi-fzfp ~/.pi/agent/extensions/pi-fzfp
```

### With pi-vim

Use the [`fzfp` branch of pi-vim](https://github.com/burneikis/pi-vim/tree/fzfp), which includes pi-fzfp as a dependency:

```bash
cd ~/.pi/agent/extensions/pi-vim
git checkout fzfp
npm install
```

**Do not install pi-fzfp separately when using the pi-vim fzfp branch** — the fuzzy matching is built in.

### With another custom editor extension

Add pi-fzfp as a dependency and import the provider wrapper:

```bash
npm install github:burneikis/pi-fzfp
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

Wraps any `AutocompleteProvider` with weighted fuzzy file matching for `@` queries. Returns the provider unchanged if `fd` is not available.

### `FuzzyFileAutocompleteProvider`

The wrapper class, if you need more control.

## How It Works

1. Intercepts `@` queries in the autocomplete provider
2. Runs `fd` to list all project files (respects `.gitignore`)
3. If the query contains `/` and is >2 chars, pre-filters to files matching the path prefix
4. Scores each file against two keys using `fuzzyMatch`:
   - `name` (basename) with weight 2 — basename matches rank higher
   - `path` (full path) with weight 1
5. Applies a suffix alignment bonus — contiguous matching characters at the end of the query/filename boost the score
6. Applies a small penalty for files with "test" in their path
7. Sorts by score and returns the top 20 results
8. Non-`@` queries (slash commands, tab path completion) pass through unchanged
