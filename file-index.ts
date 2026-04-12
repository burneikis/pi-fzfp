/**
 * Pure-TypeScript fuzzy file index, ported from claude-code's FileIndex.
 *
 * Uses nucleo-style scoring (fzf-v2 / nucleo bonuses) for high-performance
 * fuzzy file searching with no external dependencies.
 *
 * Key API:
 *   new FileIndex()
 *   .loadFromFileList(fileList: string[]): void
 *   .loadFromFileListAsync(fileList: string[]): { queryable, done }
 *   .search(query: string, limit: number): SearchResult[]
 */

export type SearchResult = {
	path: string;
	score: number;
};

// nucleo-style scoring constants
const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 4;
const BONUS_FIRST_CHAR = 8;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTENSION = 1;

const TOP_LEVEL_CACHE_LIMIT = 100;
const MAX_QUERY_LEN = 64;
const CHUNK_MS = 4;

// Reusable buffer for match positions
const posBuf = new Int32Array(MAX_QUERY_LEN);

export class FileIndex {
	private paths: string[] = [];
	private lowerPaths: string[] = [];
	private charBits: Int32Array = new Int32Array(0);
	private pathLens: Uint16Array = new Uint16Array(0);
	private topLevelCache: SearchResult[] | null = null;
	private readyCount = 0;

	loadFromFileList(fileList: string[]): void {
		const seen = new Set<string>();
		const paths: string[] = [];
		for (const line of fileList) {
			if (line.length > 0 && !seen.has(line)) {
				seen.add(line);
				paths.push(line);
			}
		}
		this.buildIndex(paths);
	}

	loadFromFileListAsync(fileList: string[]): {
		queryable: Promise<void>;
		done: Promise<void>;
	} {
		let markQueryable: () => void = () => {};
		const queryable = new Promise<void>((resolve) => {
			markQueryable = resolve;
		});
		const done = this.buildAsync(fileList, markQueryable);
		return { queryable, done };
	}

	private async buildAsync(fileList: string[], markQueryable: () => void): Promise<void> {
		const seen = new Set<string>();
		const paths: string[] = [];
		let chunkStart = performance.now();
		for (let i = 0; i < fileList.length; i++) {
			const line = fileList[i]!;
			if (line.length > 0 && !seen.has(line)) {
				seen.add(line);
				paths.push(line);
			}
			if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
				await yieldToEventLoop();
				chunkStart = performance.now();
			}
		}

		this.resetArrays(paths);

		chunkStart = performance.now();
		let firstChunk = true;
		for (let i = 0; i < paths.length; i++) {
			this.indexPath(i);
			if ((i & 0xff) === 0xff && performance.now() - chunkStart > CHUNK_MS) {
				this.readyCount = i + 1;
				if (firstChunk) {
					markQueryable();
					firstChunk = false;
				}
				await yieldToEventLoop();
				chunkStart = performance.now();
			}
		}
		this.readyCount = paths.length;
		markQueryable();
	}

	private buildIndex(paths: string[]): void {
		this.resetArrays(paths);
		for (let i = 0; i < paths.length; i++) {
			this.indexPath(i);
		}
		this.readyCount = paths.length;
	}

	private resetArrays(paths: string[]): void {
		const n = paths.length;
		this.paths = paths;
		this.lowerPaths = new Array(n);
		this.charBits = new Int32Array(n);
		this.pathLens = new Uint16Array(n);
		this.readyCount = 0;
		this.topLevelCache = computeTopLevelEntries(paths, TOP_LEVEL_CACHE_LIMIT);
	}

	private indexPath(i: number): void {
		const lp = this.paths[i]!.toLowerCase();
		this.lowerPaths[i] = lp;
		const len = lp.length;
		this.pathLens[i] = len;
		let bits = 0;
		for (let j = 0; j < len; j++) {
			const c = lp.charCodeAt(j);
			if (c >= 97 && c <= 122) bits |= 1 << (c - 97);
		}
		this.charBits[i] = bits;
	}

	search(query: string, limit: number): SearchResult[] {
		if (limit <= 0) return [];
		if (query.length === 0) {
			if (this.topLevelCache) {
				return this.topLevelCache.slice(0, limit);
			}
			return [];
		}

		const caseSensitive = query !== query.toLowerCase();
		const needle = caseSensitive ? query : query.toLowerCase();
		const nLen = Math.min(needle.length, MAX_QUERY_LEN);
		const needleChars: string[] = new Array(nLen);
		let needleBitmap = 0;
		for (let j = 0; j < nLen; j++) {
			const ch = needle.charAt(j);
			needleChars[j] = ch;
			const cc = ch.charCodeAt(0);
			if (cc >= 97 && cc <= 122) needleBitmap |= 1 << (cc - 97);
		}

		const scoreCeiling = nLen * (SCORE_MATCH + BONUS_BOUNDARY) + BONUS_FIRST_CHAR + 32;

		const topK: { path: string; fuzzScore: number }[] = [];
		let threshold = -Infinity;

		const { paths, lowerPaths, charBits, pathLens, readyCount } = this;

		outer: for (let i = 0; i < readyCount; i++) {
			if ((charBits[i]! & needleBitmap) !== needleBitmap) continue;

			const haystack = caseSensitive ? paths[i]! : lowerPaths[i]!;

			let pos = haystack.indexOf(needleChars[0]!);
			if (pos === -1) continue;
			posBuf[0] = pos;
			let gapPenalty = 0;
			let consecBonus = 0;
			let prev = pos;
			for (let j = 1; j < nLen; j++) {
				pos = haystack.indexOf(needleChars[j]!, prev + 1);
				if (pos === -1) continue outer;
				posBuf[j] = pos;
				const gap = pos - prev - 1;
				if (gap === 0) consecBonus += BONUS_CONSECUTIVE;
				else gapPenalty += PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION;
				prev = pos;
			}

			if (topK.length === limit && scoreCeiling + consecBonus - gapPenalty <= threshold) {
				continue;
			}

			const path = paths[i]!;
			const hLen = pathLens[i]!;
			let score = nLen * SCORE_MATCH + consecBonus - gapPenalty;
			score += scoreBonusAt(path, posBuf[0]!, true);
			for (let j = 1; j < nLen; j++) {
				score += scoreBonusAt(path, posBuf[j]!, false);
			}
			score += Math.max(0, 32 - (hLen >> 2));

			if (topK.length < limit) {
				topK.push({ path, fuzzScore: score });
				if (topK.length === limit) {
					topK.sort((a, b) => a.fuzzScore - b.fuzzScore);
					threshold = topK[0]!.fuzzScore;
				}
			} else if (score > threshold) {
				let lo = 0;
				let hi = topK.length;
				while (lo < hi) {
					const mid = (lo + hi) >> 1;
					if (topK[mid]!.fuzzScore < score) lo = mid + 1;
					else hi = mid;
				}
				topK.splice(lo, 0, { path, fuzzScore: score });
				topK.shift();
				threshold = topK[0]!.fuzzScore;
			}
		}

		topK.sort((a, b) => b.fuzzScore - a.fuzzScore);

		const matchCount = topK.length;
		const denom = Math.max(matchCount, 1);
		const results: SearchResult[] = new Array(matchCount);

		for (let i = 0; i < matchCount; i++) {
			const path = topK[i]!.path;
			const positionScore = i / denom;
			const finalScore = path.includes("test") ? Math.min(positionScore * 1.05, 1.0) : positionScore;
			results[i] = { path, score: finalScore };
		}

		return results;
	}
}

function scoreBonusAt(path: string, pos: number, first: boolean): number {
	if (pos === 0) return first ? BONUS_FIRST_CHAR : 0;
	const prevCh = path.charCodeAt(pos - 1);
	if (isBoundary(prevCh)) return BONUS_BOUNDARY;
	if (isLower(prevCh) && isUpper(path.charCodeAt(pos))) return BONUS_CAMEL;
	return 0;
}

function isBoundary(code: number): boolean {
	return code === 47 || code === 92 || code === 45 || code === 95 || code === 46 || code === 32;
}

function isLower(code: number): boolean {
	return code >= 97 && code <= 122;
}

function isUpper(code: number): boolean {
	return code >= 65 && code <= 90;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function computeTopLevelEntries(paths: string[], limit: number): SearchResult[] {
	const topLevel = new Set<string>();

	for (const p of paths) {
		let end = p.length;
		for (let i = 0; i < p.length; i++) {
			const c = p.charCodeAt(i);
			if (c === 47 || c === 92) {
				end = i;
				break;
			}
		}
		const segment = p.slice(0, end);
		if (segment.length > 0) {
			topLevel.add(segment);
			if (topLevel.size >= limit) break;
		}
	}

	const sorted = Array.from(topLevel);
	sorted.sort((a, b) => {
		const lenDiff = a.length - b.length;
		if (lenDiff !== 0) return lenDiff;
		return a < b ? -1 : a > b ? 1 : 0;
	});

	return sorted.slice(0, limit).map((path) => ({ path, score: 0.0 }));
}

export default FileIndex;
