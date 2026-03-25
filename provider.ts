/**
 * FuzzyFileAutocompleteProvider - Reusable wrapper that enhances any
 * AutocompleteProvider with true subsequence fuzzy matching for @ file queries.
 *
 * Import and use in any custom editor:
 *
 *   import { wrapWithFuzzyFiles } from "~/tools/fuzzy-file-picker/provider.js";
 *
 *   class MyEditor extends CustomEditor {
 *     override setAutocompleteProvider(provider: AutocompleteProvider) {
 *       super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
 *     }
 *   }
 */

import type { AutocompleteItem, AutocompleteProvider } from "@mariozechner/pi-tui";
import { fuzzyFilter, fuzzyMatch } from "@mariozechner/pi-tui";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/** Find the fd binary path. */
function findFd(): string | null {
	for (const name of ["fd", "fdfind"]) {
		const result = spawnSync("which", [name], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		if (result.status === 0 && result.stdout.trim()) {
			return result.stdout.trim();
		}
	}
	return null;
}

/** Use fd to list all files (respects .gitignore, excludes .git). */
function getAllFiles(baseDir: string, fdPath: string): { path: string; isDirectory: boolean }[] {
	const args = [
		"--base-directory", baseDir,
		"--type", "f",
		"--type", "d",
		"--hidden",
		"--exclude", ".git",
	];

	const result = spawnSync(fdPath, args, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 10 * 1024 * 1024,
	});

	if (result.status !== 0 || !result.stdout) return [];

	const entries: { path: string; isDirectory: boolean }[] = [];
	for (const line of result.stdout.trim().split("\n")) {
		if (!line) continue;
		const displayPath = line.replace(/\\/g, "/");
		const isDir = displayPath.endsWith("/");
		const normalizedPath = isDir ? displayPath.slice(0, -1) : displayPath;
		if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) continue;
		entries.push({ path: displayPath, isDirectory: isDir });
	}
	return entries;
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
 * Wraps an existing AutocompleteProvider to enhance @ file matching
 * with true fuzzy/subsequence matching via pi-tui's fuzzyFilter.
 */
export class FuzzyFileAutocompleteProvider implements AutocompleteProvider {
	private inner: AutocompleteProvider;
	private basePath: string;
	private fdPath: string | null;

	constructor(inner: AutocompleteProvider, basePath: string, fdPath: string | null) {
		this.inner = inner;
		this.basePath = basePath;
		this.fdPath = fdPath;
	}

	getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Only intercept @ file queries
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix || !this.fdPath) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol);
		}

		// Parse the raw query after @
		const isQuoted = atPrefix.startsWith('@"');
		const rawQuery = isQuoted ? atPrefix.slice(2) : atPrefix.slice(1);

		// If query is empty, let the original handler deal with it
		if (!rawQuery) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol);
		}

		// Get all files from fd, then fuzzy-filter them
		const allFiles = getAllFiles(this.basePath, this.fdPath);

		// If query contains '/', match against full path; otherwise match against
		// the basename so that characters are enforced in order within the filename
		// rather than being spread across unrelated directory segments.
		const queryHasSlash = rawQuery.includes("/");

		let matched: { path: string; isDirectory: boolean }[];
		if (queryHasSlash) {
			matched = fuzzyFilter(allFiles, rawQuery, (entry) => entry.path);
		} else {
			// Match against basename, then sort by basename score (with full-path score as tiebreaker)
			const scored: { entry: { path: string; isDirectory: boolean }; score: number }[] = [];
			for (const entry of allFiles) {
				const name = basename(entry.isDirectory ? entry.path.slice(0, -1) : entry.path);
				const m = fuzzyMatch(rawQuery, name);
				if (m.matches) {
					// Use full-path score as minor tiebreaker (prefer shorter paths)
					const pathBonus = entry.path.length * 0.01;
					scored.push({ entry, score: m.score + pathBonus });
				}
			}
			scored.sort((a, b) => a.score - b.score);
			matched = scored.map((s) => s.entry);
		}

		// Take top 20 results
		const top = matched.slice(0, 20);

		const suggestions: AutocompleteItem[] = top.map((entry) => {
			const pathWithoutSlash = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
			const displayPath = pathWithoutSlash;
			const entryName = basename(pathWithoutSlash);
			const completionPath = entry.isDirectory ? `${displayPath}/` : displayPath;

			// Build the completion value (with @ prefix, quoting if needed)
			const needsQuotes = isQuoted || completionPath.includes(" ");
			let value: string;
			if (needsQuotes) {
				value = `@"${completionPath}"`;
			} else {
				value = `@${completionPath}`;
			}

			return {
				value,
				label: entryName + (entry.isDirectory ? "/" : ""),
				description: displayPath,
			};
		});

		if (suggestions.length === 0) return null;

		return { items: suggestions, prefix: atPrefix };
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

// Cached fd path (resolved once at import time)
const _fdPath = findFd();

/**
 * Convenience wrapper: wraps any AutocompleteProvider with fuzzy file matching.
 * Returns the provider unchanged if fd is not available.
 *
 * Usage in a custom editor:
 *   override setAutocompleteProvider(provider: AutocompleteProvider) {
 *     super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
 *   }
 */
export function wrapWithFuzzyFiles(provider: AutocompleteProvider, basePath?: string): AutocompleteProvider {
	if (!_fdPath) return provider;
	return new FuzzyFileAutocompleteProvider(provider, basePath ?? process.cwd(), _fdPath);
}
