/**
 * Tests for pi-fzfp provider.
 *
 * Run with: node --experimental-strip-types --test provider.test.ts
 * (Node 22+; the fd-cache and end-to-end tests require `fd` and `fzf` on PATH.)
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
	FzfFileAutocompleteProvider,
	clearFdCache,
	extractAtPrefix,
	resolveQueryPath,
	wrapWithFuzzyFiles,
} from "./provider.ts";

/** Resolve a binary on PATH, or null if missing. */
function which(name: string): string | null {
	const r = spawnSync("which", [name], { encoding: "utf-8" });
	return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

const fdPath = which("fd") ?? which("fdfind");
const fzfPath = which("fzf");
const hasTools = Boolean(fdPath && fzfPath);

// ---------------------------------------------------------------------------
// extractAtPrefix
// ---------------------------------------------------------------------------
describe("extractAtPrefix", () => {
	test("returns null when there is no @ token", () => {
		assert.equal(extractAtPrefix("hello world"), null);
		assert.equal(extractAtPrefix(""), null);
		assert.equal(extractAtPrefix("foo@bar"), null); // @ not at token start
	});

	test("extracts a bare @ token at the start", () => {
		assert.equal(extractAtPrefix("@src"), "@src");
		assert.equal(extractAtPrefix("@"), "@");
	});

	test("extracts an @ token after whitespace", () => {
		assert.equal(extractAtPrefix("look at @provider"), "@provider");
		assert.equal(extractAtPrefix("a\t@x"), "@x");
	});

	test("extracts the last @ token before the cursor", () => {
		assert.equal(extractAtPrefix("@one @two"), "@two");
	});

	test("handles quoted @\"...\" prefixes with spaces", () => {
		assert.equal(extractAtPrefix('@"my file'), '@"my file');
		assert.equal(extractAtPrefix('see @"a b'), '@"a b');
	});

	test("preserves path segments inside the token", () => {
		assert.equal(extractAtPrefix("@src/foo/bar"), "@src/foo/bar");
		assert.equal(extractAtPrefix("@~/Code"), "@~/Code");
	});
});

// ---------------------------------------------------------------------------
// resolveQueryPath
// ---------------------------------------------------------------------------
describe("resolveQueryPath", () => {
	const base = "/home/user/project";

	test("plain query searches in basePath with no dir prefix", () => {
		assert.deepEqual(resolveQueryPath("foo", base), {
			searchDir: base,
			fileQuery: "foo",
			dirPrefix: "",
		});
	});

	test("bare ~ lists the home directory", () => {
		assert.deepEqual(resolveQueryPath("~", base), {
			searchDir: homedir(),
			fileQuery: "",
			dirPrefix: "~/",
		});
	});

	test("bare / lists the filesystem root", () => {
		assert.deepEqual(resolveQueryPath("/", base), {
			searchDir: "/",
			fileQuery: "",
			dirPrefix: "/",
		});
	});

	test("~/sub resolves under home and keeps the prefix", () => {
		const r = resolveQueryPath("~/Code/foo", base);
		assert.equal(r.searchDir, join(homedir(), "Code/"));
		assert.equal(r.fileQuery, "foo");
		assert.equal(r.dirPrefix, "~/Code/");
	});

	test("absolute dir prefix is used as-is", () => {
		const r = resolveQueryPath("/etc/host", base);
		assert.equal(r.searchDir, "/etc/");
		assert.equal(r.fileQuery, "host");
		assert.equal(r.dirPrefix, "/etc/");
	});

	test("relative subdir resolves against basePath", () => {
		const r = resolveQueryPath("src/index", base);
		assert.equal(r.searchDir, join(base, "src"));
		assert.equal(r.fileQuery, "index");
		assert.equal(r.dirPrefix, "src/");
	});

	test("../ parent traversal resolves correctly", () => {
		const r = resolveQueryPath("../sibling/file", base);
		assert.equal(r.searchDir, "/home/user/sibling");
		assert.equal(r.fileQuery, "file");
		assert.equal(r.dirPrefix, "../sibling/");
	});

	test("trailing slash yields an empty fileQuery", () => {
		const r = resolveQueryPath("src/", base);
		assert.equal(r.searchDir, join(base, "src"));
		assert.equal(r.fileQuery, "");
		assert.equal(r.dirPrefix, "src/");
	});
});

// ---------------------------------------------------------------------------
// FzfFileAutocompleteProvider (end-to-end with real fd + fzf)
// ---------------------------------------------------------------------------
describe("FzfFileAutocompleteProvider", { skip: !hasTools }, () => {
	let dir: string;
	/** Minimal inner provider that records delegation and returns a sentinel. */
	const makeInner = () => {
		const calls: string[] = [];
		const inner = {
			triggerCharacters: [],
			getSuggestions: (..._args: any[]) => {
				calls.push("getSuggestions");
				return { items: [{ value: "INNER", label: "inner" }], prefix: "" };
			},
			applyCompletion: (..._args: any[]) => {
				calls.push("applyCompletion");
				return { lines: [], cursorLine: 0, cursorCol: 0 };
			},
			shouldTriggerFileCompletion: () => true,
		};
		return { inner, calls };
	};

	const provider = (inner: any) =>
		new FzfFileAutocompleteProvider(inner, dir, fdPath!, fzfPath!);

	/** Convenience: run getSuggestions over a single line. */
	const suggest = (p: FzfFileAutocompleteProvider, line: string) =>
		p.getSuggestions([line], 0, line.length);

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "fzfp-test-"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "alpha.ts"), "");
		writeFileSync(join(dir, "src", "beta.ts"), "");
		writeFileSync(join(dir, "readme.md"), "");
		clearFdCache();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
		clearFdCache();
	});

	test("delegates to inner provider when there is no @ token", () => {
		const { inner, calls } = makeInner();
		const res = suggest(provider(inner), "hello world");
		assert.deepEqual(calls, ["getSuggestions"]);
		assert.equal((res as any).items[0].value, "INNER");
	});

	test("delegates to inner provider for a bare @ (empty query)", () => {
		const { inner, calls } = makeInner();
		suggest(provider(inner), "@");
		assert.deepEqual(calls, ["getSuggestions"]);
	});

	test("fuzzy-matches files for an @ query", () => {
		const { inner } = makeInner();
		const res = suggest(provider(inner), "@alpha") as any;
		assert.ok(res, "expected suggestions");
		const values = res.items.map((i: any) => i.value);
		assert.ok(
			values.includes("@src/alpha.ts"),
			`expected @src/alpha.ts in ${JSON.stringify(values)}`,
		);
		assert.equal(res.prefix, "@alpha");
	});

	test("returns directory entries with a trailing slash", () => {
		const { inner } = makeInner();
		const res = suggest(provider(inner), "@src") as any;
		const dirItem = res.items.find((i: any) => i.label === "src/");
		assert.ok(dirItem, "expected a src/ directory entry");
		assert.equal(dirItem.value, "@src/");
	});

	test("scopes results to a directory prefix", () => {
		const { inner } = makeInner();
		const res = suggest(provider(inner), "@src/beta") as any;
		const values = res.items.map((i: any) => i.value);
		assert.ok(values.every((v: string) => v.startsWith("@src/")), JSON.stringify(values));
		assert.ok(values.includes("@src/beta.ts"));
	});

	test("applyCompletion delegates to the inner provider", () => {
		const { inner, calls } = makeInner();
		provider(inner).applyCompletion([], 0, 0, { value: "@x", label: "x" } as any, "@x");
		assert.deepEqual(calls, ["applyCompletion"]);
	});

	test("triggers on the @ character", () => {
		const { inner } = makeInner();
		assert.deepEqual(provider(inner).triggerCharacters, ["@"]);
	});
});

// ---------------------------------------------------------------------------
// fd output caching
// ---------------------------------------------------------------------------
describe("fd caching", { skip: !hasTools }, () => {
	let dir: string;

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "fzfp-cache-"));
		writeFileSync(join(dir, "first.ts"), "");
		clearFdCache();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
		clearFdCache();
	});

	test("a file created after the first scan is not visible within the TTL window", () => {
		const p = new FzfFileAutocompleteProvider(
			{
				triggerCharacters: [],
				getSuggestions: () => null,
				applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
			} as any,
			dir,
			fdPath!,
			fzfPath!,
		);

		// Prime the cache.
		const first = p.getSuggestions(["@first"], 0, 6) as any;
		assert.ok(first.items.some((i: any) => i.value === "@first.ts"));

		// Create a new file; it must NOT appear while the cache is warm.
		writeFileSync(join(dir, "second.ts"), "");
		const cached = p.getSuggestions(["@second"], 0, 7);
		assert.equal(cached, null, "second.ts should be hidden behind the cache");

		// After clearing the cache, the new file becomes visible.
		clearFdCache();
		const fresh = p.getSuggestions(["@second"], 0, 7) as any;
		assert.ok(
			fresh && fresh.items.some((i: any) => i.value === "@second.ts"),
			"second.ts should appear after cache refresh",
		);
	});
});

// ---------------------------------------------------------------------------
// full-depth parity
// ---------------------------------------------------------------------------
describe("full-depth parity", { skip: !hasTools }, () => {
	let dir: string;

	const makeProvider = (base: string) =>
		new FzfFileAutocompleteProvider(
			{
				triggerCharacters: [],
				getSuggestions: () => null,
				applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
			} as any,
			base,
			fdPath!,
			fzfPath!,
		);

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "fzfp-deep-"));
		// A deeply nested file (6 segments) plus a shallow one.
		mkdirSync(join(dir, "a", "b", "c", "d", "e"), { recursive: true });
		writeFileSync(join(dir, "a", "b", "c", "d", "e", "needle.ts"), "");
		writeFileSync(join(dir, "surface.ts"), "");
		clearFdCache();
	});

	after(() => {
		rmSync(dir, { recursive: true, force: true });
		clearFdCache();
	});

	test("finds shallow files", () => {
		clearFdCache();
		const res = makeProvider(dir).getSuggestions(["@surface"], 0, 8) as any;
		assert.ok(res?.items.some((i: any) => i.value === "@surface.ts"));
	});

	test("finds deeply nested files (full-depth scan)", () => {
		clearFdCache();
		const res = makeProvider(dir).getSuggestions(["@needle"], 0, 7) as any;
		assert.ok(
			res?.items.some((i: any) => i.value.endsWith("needle.ts")),
			`expected deep needle.ts, got ${JSON.stringify(res?.items?.map((i: any) => i.value))}`,
		);
	});

	test("finds a deep file even when a shallow file also matches the query", () => {
		clearFdCache();
		// Both surface and a deep file share the "e" subsequence; the deep one
		// must still appear (regression: depth-limited scans hid it).
		writeFileSync(join(dir, "a", "b", "c", "d", "e", "surface-deep.ts"), "");
		const res = makeProvider(dir).getSuggestions(["@surface"], 0, 8) as any;
		const values = res?.items.map((i: any) => i.value) ?? [];
		assert.ok(values.some((v: string) => v.endsWith("surface-deep.ts")), JSON.stringify(values));
	});
});

// ---------------------------------------------------------------------------
// wrapWithFuzzyFiles
// ---------------------------------------------------------------------------
describe("wrapWithFuzzyFiles", () => {
	test("returns a provider (wrapped when tools exist, passthrough otherwise)", () => {
		const inner = {
			triggerCharacters: [],
			getSuggestions: () => null,
			applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }),
		} as any;
		const wrapped = wrapWithFuzzyFiles(inner, process.cwd());
		if (hasTools) {
			assert.ok(wrapped instanceof FzfFileAutocompleteProvider);
		} else {
			assert.equal(wrapped, inner);
		}
	});
});
