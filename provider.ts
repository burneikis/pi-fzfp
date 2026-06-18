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
import { readFileSync } from "node:fs";
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

/** Read ~/.pi/agent/.fzfpignore once and return patterns as --exclude args. */
function loadFzfpIgnore(): string[] {
	const filePath = join(homedir(), ".pi", "agent", ".fzfpignore");
	try {
		return readFileSync(filePath, "utf-8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#"));
	} catch {
		return [];
	}
}

const _ignorePatterns: string[] = loadFzfpIgnore();

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

/** Time-to-live for cached fd listings, in milliseconds. */
const FD_CACHE_TTL_MS = 30_000;

interface FdCacheEntry {
	lines: string[];
	expires: number;
}

/** Per-directory cache of fd output, keyed by base directory. */
const _fdCache = new Map<string, FdCacheEntry>();

/**
 * List files/dirs under baseDir using fd, caching the result per directory
 * with a short TTL. fd (the filesystem walk) is the expensive part, so on
 * repeated keystrokes we reuse the in-memory listing instead of re-scanning.
 */
function listFiles(baseDir: string, fdPath: string, ignorePatterns: string[]): string[] {
	const now = Date.now();
	const cached = _fdCache.get(baseDir);
	if (cached && cached.expires > now) {
		return cached.lines;
	}

	const args = [
		"--base-directory",
		baseDir,
		"--type",
		"f",
		"--type",
		"d",
		"--hidden",
		"--exclude",
		".git",
		...ignorePatterns.flatMap((p) => ["--exclude", p]),
	];

	const result = spawnSync(fdPath, args, {
		encoding: "utf-8",
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 100 * 1024 * 1024,
	});

	const lines = result.stdout ? result.stdout.trim().split("\n").filter(Boolean) : [];
	_fdCache.set(baseDir, { lines, expires: now + FD_CACHE_TTL_MS });
	return lines;
}

/**
 * List files under baseDir (cached) and fuzzy-match them with fzf --filter.
 * Returns paths sorted by fzf's scoring (best match first).
 * When query is empty, the cached fd listing is returned directly.
 */
function fzfFilter(query: string, baseDir: string, fdPath: string, fzfPath: string, ignorePatterns: string[]): string[] {
	const files = listFiles(baseDir, fdPath, ignorePatterns);
	if (query === "" || files.length === 0) return files;

	const result = spawnSync(fzfPath, ["--filter", query], {
		encoding: "utf-8",
		input: files.join("\n"),
		stdio: ["pipe", "pipe", "pipe"],
		maxBuffer: 100 * 1024 * 1024,
	});

	// fzf --filter exits 0 on matches, 1 on no matches.
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

	/** Trigger fzf matching as soon as an @ is typed. */
	triggerCharacters = ["@"];

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
		const matches = fzfFilter(fileQuery, searchDir, this.fdPath, this.fzfPath, _ignorePatterns);

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

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
		return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
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
