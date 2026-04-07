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
import { basename, isAbsolute, resolve, join } from "node:path";
import { homedir } from "node:os";

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

/** Shell-escape a string for single-quoted context. */
function shellEscape(s: string): string {
	return s.replace(/'/g, "'\\''");
}

/**
 * Resolve a directory prefix from a raw query string.
 * Handles ~, absolute paths, and relative paths (including ../).
 * Returns { searchDir, fileQuery, dirPrefix }.
 */
function resolveQueryPath(
	rawQuery: string,
	basePath: string,
): { searchDir: string; fileQuery: string; dirPrefix: string } {
	const lastSlash = rawQuery.lastIndexOf("/");

	// No slash — check if the query itself implies a root (~ or /)
	if (lastSlash === -1) {
		if (rawQuery === "~") {
			// Treat bare ~ as listing the home dir
			return { searchDir: homedir(), fileQuery: "", dirPrefix: "~/" };
		}
		if (rawQuery === "/") {
			return { searchDir: "/", fileQuery: "", dirPrefix: "/" };
		}
		// Plain query with no path component — search in basePath
		return { searchDir: basePath, fileQuery: rawQuery, dirPrefix: "" };
	}

	const dirPrefix = rawQuery.slice(0, lastSlash + 1); // includes trailing slash
	const fileQuery = rawQuery.slice(lastSlash + 1);

	let searchDir: string;
	if (dirPrefix.startsWith("~/")) {
		searchDir = join(homedir(), dirPrefix.slice(2));
	} else if (isAbsolute(dirPrefix)) {
		searchDir = dirPrefix;
	} else {
		// Handles ./, ../, bare subdir names, ../../ chains, etc.
		searchDir = resolve(basePath, dirPrefix);
	}

	return { searchDir, fileQuery, dirPrefix };
}

/**
 * Run fd piped into fzf --filter via a shell pipe.
 * This avoids buffering fd's entire output in Node — important for large
 * directories like ~ where fd can produce hundreds of MBs.
 * Returns paths sorted by fzf's scoring (best match first).
 * When fileQuery is empty, fd output is returned directly (no fzf needed).
 */
function fzfFilter(query: string, baseDir: string, fdPath: string, fzfPath: string): string[] {
	let cmd: string;
	if (query === "") {
		// Empty query — list everything fd finds, no fzf scoring needed
		cmd = `'${shellEscape(fdPath)}' --base-directory '${shellEscape(baseDir)}' --type f --type d --hidden --exclude .git`;
	} else {
		cmd = `'${shellEscape(fdPath)}' --base-directory '${shellEscape(baseDir)}' --type f --type d --hidden --exclude .git | '${shellEscape(fzfPath)}' --filter '${shellEscape(query)}'`;
	}

	const result = spawnSync("sh", ["-c", cmd], {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 10 * 1024 * 1024,
	});

	// fzf --filter exits 0 on matches, 1 on no matches;
	// the pipe means sh returns fzf's exit code
	if (!result.stdout) return [];

	return result.stdout.trim().split("\n").filter(Boolean);
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

		// Resolve the search directory and file query from the raw query
		const { searchDir, fileQuery, dirPrefix } = resolveQueryPath(rawQuery, this.basePath);

		// Use fzf --filter for fuzzy matching
		const matches = fzfFilter(fileQuery, searchDir, this.fdPath, this.fzfPath);

		return this.buildSuggestions(matches, atPrefix, isQuoted, dirPrefix);
	}

	private buildSuggestions(
		paths: string[],
		atPrefix: string,
		isQuoted: boolean,
		dirPrefix: string = "",
	): { items: AutocompleteItem[]; prefix: string } | null {
		const suggestions: AutocompleteItem[] = paths.map((rawPath) => {
			const displayPath = rawPath.replace(/\\/g, "/");
			const isDir = displayPath.endsWith("/");
			const pathWithoutSlash = isDir ? displayPath.slice(0, -1) : displayPath;
			const entryName = basename(pathWithoutSlash);
			// Prepend the directory prefix so the completion inserts the full path
			const completionPath = isDir
				? `${dirPrefix}${pathWithoutSlash}/`
				: `${dirPrefix}${pathWithoutSlash}`;

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
				description: completionPath,
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
