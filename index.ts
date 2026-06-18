/**
 * Fuzzy File Picker Extension (fzf-powered)
 *
 * Enhances pi's @file autocomplete using fd + fzf --filter.
 *
 * Stacks an fzf-powered autocomplete provider on top of the built-in
 * provider via ctx.ui.addAutocompleteProvider(). @ file queries are
 * matched with fzf; everything else delegates to the underlying provider.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { wrapWithFuzzyFiles } from "./provider.js";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => wrapWithFuzzyFiles(current, ctx.cwd));
	});
}
