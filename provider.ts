/**
 * FzfFileAutocompleteProvider - Wraps any AutocompleteProvider with fzf-powered
 * fuzzy matching for @ file queries.
 *
 * Uses `fd` to list files and `fzf --filter` for non-interactive fuzzy matching
 * and scoring. No custom scoring logic — just fzf.
 *
 * Import and use in any custom editor:
 *
 *   import { wrapWithFuzzyFiles } from "pi-fzfp/provider";
 *
 *   class MyEditor extends CustomEditor {
 *     override setAutocompleteProvider(provider: AutocompleteProvider) {
 *       super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
 *     }
 *   }
 */

import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/** Find a binary on PATH. */
function findBinary(names: string[]): string | null {
	for (const name of names) {
		const result = spawnSync("which", [name], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		if (result.status === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	}
	return null;
}

const PATH_DELIMITERS = new Set([" ", "\t", '"', "'"]);

/** Extract the @-prefixed token from text before cursor. */
function extractAtPrefix(text: string): string | null {
	// Handle quoted @"..." prefix
	let inQuotes = false;
	let quoteStart = -1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '"') {
			inQuotes = !inQuotes;
			if (inQuotes) quoteStart = i;
		}
	}
	if (inQuotes && quoteStart !== null && quoteStart > 0 && text[quoteStart - 1] === "@") {
		const tokenStart = quoteStart - 1;
		if (tokenStart === 0 || PATH_DELIMITERS.has(text[tokenStart - 1]!)) {
			return text.slice(tokenStart);
		}
	}

	// Find the last delimiter to locate the current token
	let lastDelim = -1;
	for (let i = text.length - 1; i >= 0; i--) {
		if (PATH_DELIMITERS.has(text[i]!)) { lastDelim = i; break; }
	}
	const tokenStart = lastDelim + 1;
	if (text[tokenStart] === "@") {
		return text.slice(tokenStart);
	}
	return null;
}

/**
 * Run fd piped into fzf --filter to get fuzzy-matched file results.
 * Returns paths sorted by fzf's scoring (best match first).
 */
function fzfFilter(query: string, baseDir: string, fdPath: string, fzfPath: string): string[] {
	// Run fd to list all files and directories
	const fdArgs = [
		"--base-directory", baseDir,
		"--type", "f",
		"--type", "d",
		"--hidden",
		"--exclude", ".git",
	];

	const fdResult = spawnSync(fdPath, fdArgs, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 10 * 1024 * 1024,
	});

	if (fdResult.status !== 0 || !fdResult.stdout) return [];

	// Pipe fd output into fzf --filter for non-interactive fuzzy matching
	const fzfResult = spawnSync(fzfPath, ["--filter", query], {
		input: fdResult.stdout,
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 10 * 1024 * 1024,
	});

	// fzf --filter exits 0 on matches, 1 on no matches
	if (!fzfResult.stdout) return [];

	return fzfResult.stdout.trim().split("\n").filter(Boolean);
}

/**
 * Wraps an existing AutocompleteProvider to enhance @ file matching
 * with fzf-powered fuzzy matching.
 */
export class FzfFileAutocompleteProvider implements AutocompleteProvider {
	private inner: AutocompleteProvider;
	private basePath: string;
	private fdPath: string;
	private fzfPath: string;

	constructor(inner: AutocompleteProvider, basePath: string, fdPath: string, fzfPath: string) {
		this.inner = inner;
		this.basePath = basePath;
		this.fdPath = fdPath;
		this.fzfPath = fzfPath;
	}

	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options?: any) {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Only intercept @ file queries
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		// Parse the raw query after @
		const isQuoted = atPrefix.startsWith('@"');
		const rawQuery = isQuoted ? atPrefix.slice(2) : atPrefix.slice(1);

		// If query is empty, let the original handler deal with it
		if (!rawQuery) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		// Use fzf --filter for fuzzy matching
		const matches = fzfFilter(rawQuery, this.basePath, this.fdPath, this.fzfPath);

		// Take top 20 results
		const top = matches.slice(0, 20);

		return this.buildSuggestions(top, atPrefix, isQuoted);
	}

	private buildSuggestions(
		paths: string[],
		atPrefix: string,
		isQuoted: boolean,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const suggestions: AutocompleteItem[] = paths.map((rawPath) => {
			const displayPath = rawPath.replace(/\\/g, "/");
			const isDir = displayPath.endsWith("/");
			const pathWithoutSlash = isDir ? displayPath.slice(0, -1) : displayPath;
			const entryName = basename(pathWithoutSlash);
			const completionPath = isDir ? `${pathWithoutSlash}/` : pathWithoutSlash;

			const needsQuotes = isQuoted || completionPath.includes(" ");
			let value: string;
			if (needsQuotes) {
				value = `@"${completionPath}"`;
			} else {
				value = `@${completionPath}`;
			}

			return {
				value,
				label: entryName + (isDir ? "/" : ""),
				description: pathWithoutSlash,
			};
		});

		if (suggestions.length === 0) return null;

		return { items: suggestions, prefix: atPrefix };
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

// Cached binary paths (resolved once at import time)
const _fdPath = findBinary(["fd", "fdfind"]);
const _fzfPath = findBinary(["fzf"]);

/**
 * Convenience wrapper: wraps any AutocompleteProvider with fzf-powered fuzzy file matching.
 * Returns the provider unchanged if fd or fzf is not available.
 *
 * Usage in a custom editor:
 *   override setAutocompleteProvider(provider: AutocompleteProvider) {
 *     super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
 *   }
 */
export function wrapWithFuzzyFiles(provider: AutocompleteProvider, basePath?: string): AutocompleteProvider {
	if (!_fdPath || !_fzfPath) return provider;
	return new FzfFileAutocompleteProvider(provider, basePath ?? process.cwd(), _fdPath, _fzfPath);
}
