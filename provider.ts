/**
 * FzfFileAutocompleteProvider - Wraps any AutocompleteProvider with in-process
 * fuzzy matching for @ file queries.
 *
 * Uses `rg --files` (or `fd` as fallback) to collect file paths, then scores
 * them with a pure-TypeScript fuzzy matcher (nucleo-style scoring). No external
 * fzf dependency required at query time.
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
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, resolve, join } from "node:path";
import { homedir } from "node:os";
import { FileIndex } from "./file-index.js";

const MAX_RESULTS = 50;

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

/** Read ~/.pi/agent/.fzfpignore once and return patterns. */
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
		if (PATH_DELIMITERS.has(text[i]!)) {
			lastDelim = i;
			break;
		}
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

	if (lastSlash === -1) {
		if (rawQuery === "~") {
			return { searchDir: homedir(), fileQuery: "", dirPrefix: "~/" };
		}
		if (rawQuery === "/") {
			return { searchDir: "/", fileQuery: "", dirPrefix: "/" };
		}
		return { searchDir: basePath, fileQuery: rawQuery, dirPrefix: "" };
	}

	const dirPrefix = rawQuery.slice(0, lastSlash + 1);
	const fileQuery = rawQuery.slice(lastSlash + 1);

	let searchDir: string;
	if (dirPrefix.startsWith("~/")) {
		searchDir = join(homedir(), dirPrefix.slice(2));
	} else if (isAbsolute(dirPrefix)) {
		searchDir = dirPrefix;
	} else {
		searchDir = resolve(basePath, dirPrefix);
	}

	return { searchDir, fileQuery, dirPrefix };
}

/**
 * Manages a FileIndex for a given directory. Spawns rg/fd asynchronously to
 * collect file paths and feeds them into the index incrementally.
 */
class DirIndex {
	readonly index = new FileIndex();
	private _queryable: Promise<void>;
	private _done: Promise<void>;

	constructor(dir: string, listerPath: string, listerType: "rg" | "fd", ignorePatterns: string[]) {
		const { queryable, done } = this.startListing(dir, listerPath, listerType, ignorePatterns);
		this._queryable = queryable;
		this._done = done;
	}

	get queryable(): Promise<void> {
		return this._queryable;
	}

	get done(): Promise<void> {
		return this._done;
	}

	private startListing(
		dir: string,
		listerPath: string,
		listerType: "rg" | "fd",
		ignorePatterns: string[],
	): { queryable: Promise<void>; done: Promise<void> } {
		const args: string[] = [];

		if (listerType === "rg") {
			args.push("--files", "--hidden", "--glob", "!.git");
			for (const p of ignorePatterns) {
				args.push("--glob", `!${p}`);
			}
		} else {
			args.push("--base-directory", dir, "--type", "f", "--type", "d", "--hidden", "--exclude", ".git");
			for (const p of ignorePatterns) {
				args.push("--exclude", p);
			}
		}

		const child = spawn(listerPath, args, {
			cwd: dir,
			stdio: ["ignore", "pipe", "ignore"],
		});

		let queryableResolve: () => void;
		let doneResolve: () => void;
		const queryable = new Promise<void>((r) => (queryableResolve = r));
		const done = new Promise<void>((r) => (doneResolve = r));

		const lines: string[] = [];
		let partial = "";

		child.stdout!.on("data", (chunk: Buffer) => {
			const text = partial + chunk.toString("utf-8");
			const parts = text.split("\n");
			partial = parts.pop()!;
			for (const line of parts) {
				if (line.length > 0) lines.push(line);
			}
		});

		child.on("close", () => {
			if (partial.length > 0) lines.push(partial);
			const { queryable: q, done: d } = this.index.loadFromFileListAsync(lines);
			q.then(() => queryableResolve!());
			d.then(() => doneResolve!());
		});

		child.on("error", () => {
			// If the lister fails, resolve with empty index
			queryableResolve!();
			doneResolve!();
		});

		return { queryable, done };
	}
}

/**
 * Wraps an existing AutocompleteProvider to enhance @ file matching
 * with in-process fuzzy matching.
 */
export class FzfFileAutocompleteProvider implements AutocompleteProvider {
	private inner: AutocompleteProvider;
	private basePath: string;
	private listerPath: string;
	private listerType: "rg" | "fd";
	private dirIndexes = new Map<string, DirIndex>();

	constructor(inner: AutocompleteProvider, basePath: string, listerPath: string, listerType: "rg" | "fd") {
		this.inner = inner;
		this.basePath = basePath;
		this.listerPath = listerPath;
		this.listerType = listerType;

		// Pre-warm the base directory index
		this.getOrCreateDirIndex(basePath);
	}

	private getOrCreateDirIndex(dir: string): DirIndex {
		let di = this.dirIndexes.get(dir);
		if (!di) {
			di = new DirIndex(dir, this.listerPath, this.listerType, _ignorePatterns);
			this.dirIndexes.set(dir, di);
		}
		return di;
	}

	getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options?: any) {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		const atPrefix = extractAtPrefix(textBeforeCursor);
		if (!atPrefix) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const isQuoted = atPrefix.startsWith('@"');
		const rawQuery = isQuoted ? atPrefix.slice(2) : atPrefix.slice(1);

		if (!rawQuery) {
			return this.inner.getSuggestions(lines, cursorLine, cursorCol, options);
		}

		const { searchDir, fileQuery, dirPrefix } = resolveQueryPath(rawQuery, this.basePath);
		const di = this.getOrCreateDirIndex(searchDir);

		// Search the index (works on whatever is indexed so far)
		const results = di.index.search(fileQuery, MAX_RESULTS);

		return this.buildSuggestions(
			results.map((r) => r.path),
			atPrefix,
			isQuoted,
			dirPrefix,
		);
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
			const completionPath = isDir ? `${dirPrefix}${pathWithoutSlash}/` : `${dirPrefix}${pathWithoutSlash}`;

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

// Resolve lister binary once at import time: prefer rg, fallback to fd
const _rgPath = findBinary(["rg"]);
const _fdPath = findBinary(["fd", "fdfind"]);
const _listerPath = _rgPath ?? _fdPath;
const _listerType: "rg" | "fd" = _rgPath ? "rg" : "fd";

/**
 * Convenience wrapper: wraps any AutocompleteProvider with in-process fuzzy file matching.
 * Returns the provider unchanged if neither rg nor fd is available.
 */
export function wrapWithFuzzyFiles(provider: AutocompleteProvider, basePath?: string): AutocompleteProvider {
	if (!_listerPath) return provider;
	return new FzfFileAutocompleteProvider(provider, basePath ?? process.cwd(), _listerPath, _listerType);
}
