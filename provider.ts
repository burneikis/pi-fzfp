/**
 * FuzzyFileAutocompleteProvider - Reusable wrapper that enhances any
 * AutocompleteProvider with weighted fuzzy matching for @ file queries.
 *
 * Scoring strategy:
 *   - Each file is indexed with two keys: path (weight: 1) and basename (weight: 2)
 *   - Basename matches are scored 2x higher than full-path matches
 *   - Suffix alignment bonus: when the end of the query matches the end of the
 *     filename, each aligned character adds a bonus — so "acts" prefers "abct.ts"
 *     over "abct.scss" because "ts" aligns with the extension
 *   - If query contains "/", fuzzy-matches the full query against full paths
 *     so nested directories work (e.g. "abc/agts" finds "src/abc/abceg.ts")
 *   - Results sorted by weighted score (lower = better), with a penalty for
 *     files containing "test" in their path as a tiebreaker
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
import { fuzzyMatch } from "@mariozechner/pi-tui";
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

interface FileEntry {
	path: string;
	name: string;
	isDirectory: boolean;
}

/** Use fd to list all files (respects .gitignore, excludes .git). */
function getAllFiles(baseDir: string, fdPath: string): FileEntry[] {
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

	const entries: FileEntry[] = [];
	for (const line of result.stdout.trim().split("\n")) {
		if (!line) continue;
		const displayPath = line.replace(/\\/g, "/");
		const isDir = displayPath.endsWith("/");
		const normalizedPath = isDir ? displayPath.slice(0, -1) : displayPath;
		if (normalizedPath === ".git" || normalizedPath.startsWith(".git/") || normalizedPath.includes("/.git/")) continue;
		entries.push({
			path: displayPath,
			name: basename(normalizedPath),
			isDirectory: isDir,
		});
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

/** Small penalty added to the sort score for files with "test" in their path. */
const TEST_PENALTY = 0.001;

/** Weight for basename key (2x path weight). */
const BASENAME_WEIGHT = 2;
/** Weight for full path key. */
const PATH_WEIGHT = 1;

/**
 * Bonus per character of contiguous suffix alignment between query and target.
 * When the tail of the query matches the tail of the filename, this rewards
 * extension-aware matches: "acts" → "abct.ts" beats "abct.scss" because "ts"
 * aligns at the end (2 chars × bonus) vs only "s" (1 char × bonus).
 */
const SUFFIX_BONUS = 15;

/**
 * Count how many characters at the end of `query` match contiguously
 * at the end of `target` (case-insensitive).
 */
function suffixMatchLen(query: string, target: string): number {
	let qi = query.length - 1;
	let ti = target.length - 1;
	let count = 0;
	while (qi >= 0 && ti >= 0) {
		if (query[qi]!.toLowerCase() === target[ti]!.toLowerCase()) {
			count++;
			qi--;
			ti--;
		} else {
			break;
		}
	}
	return count;
}

/**
 * Score a file entry by fuzzy-matching the full query (which may contain "/")
 * against the full path only. Used when the query includes directory separators.
 */
function scoreEntryPath(query: string, entry: FileEntry): number | null {
	const pathTarget = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;
	const pathMatch = fuzzyMatch(query, pathTarget);
	if (!pathMatch.matches) return null;
	const sml = suffixMatchLen(query, pathTarget);
	return (pathMatch.score - sml * SUFFIX_BONUS) / PATH_WEIGHT;
}

/**
 * Score a file entry against a query using weighted dual-key matching.
 *
 * Each file is matched against two keys:
 *   - basename (weight: 2) — filename matches count double
 *   - full path (weight: 1) — still searchable but lower priority
 *
 * Additionally, a suffix alignment bonus is applied to basename matches
 * to prefer files whose extension aligns with the query tail.
 *
 * Returns the best (lowest) weighted score, or null if no match.
 * fuzzyMatch scores are negative (more negative = better), so we
 * divide by weight to make weighted matches "more negative" (better).
 */
function scoreEntry(query: string, entry: FileEntry): number | null {
	const nameTarget = entry.name;
	const pathTarget = entry.isDirectory ? entry.path.slice(0, -1) : entry.path;

	const nameMatch = fuzzyMatch(query, nameTarget);
	const pathMatch = fuzzyMatch(query, pathTarget);

	let bestScore: number | null = null;

	if (nameMatch.matches) {
		const sml = suffixMatchLen(query, nameTarget);
		const weighted = (nameMatch.score - sml * SUFFIX_BONUS) / BASENAME_WEIGHT;
		if (bestScore === null || weighted < bestScore) {
			bestScore = weighted;
		}
	}

	if (pathMatch.matches) {
		const sml = suffixMatchLen(query, pathTarget);
		const weighted = (pathMatch.score - sml * SUFFIX_BONUS) / PATH_WEIGHT;
		if (bestScore === null || weighted < bestScore) {
			bestScore = weighted;
		}
	}

	return bestScore;
}

/**
 * Wraps an existing AutocompleteProvider to enhance @ file matching
 * with weighted fuzzy matching. Each file is scored on both its full path
 * (weight 1) and its basename (weight 2), so basename matches rank higher.
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

	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options?: any) {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Only intercept @ file queries
		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix || !this.fdPath) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		// Parse the raw query after @
		const isQuoted = atPrefix.startsWith('@"');
		const rawQuery = isQuoted ? atPrefix.slice(2) : atPrefix.slice(1);

		// If query is empty, let the original handler deal with it
		if (!rawQuery) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		// Get all files from fd
		let allFiles = getAllFiles(this.basePath, this.fdPath);

		// --- Path prefix pre-filtering ---
		// If query ends with "/" exactly, show all files under matching directories.
		// Otherwise, if query contains "/", fuzzy-match the full query against
		// the full path so nested directories work (e.g. "abc/agts" matches
		// "src/abc/abceg.ts").
		const lastSlash = rawQuery.lastIndexOf("/");
		const queryHasSlash = lastSlash !== -1;

		if (queryHasSlash && rawQuery.length > 2) {
			// If query ends with "/" (user typed a dir prefix), show directory contents
			const afterSlash = rawQuery.slice(lastSlash + 1);
			if (!afterSlash) {
				const queryPrefix = rawQuery.toLowerCase();
				allFiles = allFiles.filter((entry) => {
					return entry.path.toLowerCase().includes(queryPrefix);
				});
				const top = allFiles.slice(0, 20);
				return this.buildSuggestions(top, atPrefix, isQuoted);
			}
			// Otherwise, keep searchQuery as the full rawQuery for path matching,
			// but also try the basename-only portion for basename matching.
		}

		// --- Weighted fuzzy scoring ---
		const scored: { entry: FileEntry; sortScore: number }[] = [];
		for (const entry of allFiles) {
			let bestScore: number | null;

			if (queryHasSlash) {
				// When query has "/", only match the full query against the
				// full path — no basename-only fallback, which would pull in
				// unrelated files from other directories.
				bestScore = scoreEntryPath(rawQuery, entry);
			} else {
				// No slash: original dual-key scoring (basename + path)
				bestScore = scoreEntry(rawQuery, entry);
			}

			if (bestScore !== null) {
				const hasTest = /test/i.test(entry.path);
				scored.push({
					entry,
					sortScore: bestScore + (hasTest ? TEST_PENALTY : 0),
				});
			}
		}

		// Sort by score (lower = better)
		scored.sort((a, b) => a.sortScore - b.sortScore);

		// Take top 20 results
		const top = scored.slice(0, 20).map((s) => s.entry);

		return this.buildSuggestions(top, atPrefix, isQuoted);
	}

	private buildSuggestions(
		entries: FileEntry[],
		atPrefix: string,
		isQuoted: boolean,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const suggestions: AutocompleteItem[] = entries.map((entry) => {
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
