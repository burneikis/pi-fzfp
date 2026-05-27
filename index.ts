/**
 * Fuzzy File Picker Extension (fzf-powered)
 *
 * Enhances pi's @file autocomplete using fd + fzf --filter.
 *
 * Uses ctx.ui.addAutocompleteProvider() to wrap the built-in autocomplete
 * provider with fzf filtering, without replacing the editor component.
 * This keeps all footers and UI layout intact.
 *
 * ## With pi-vim (or another custom editor):
 *   Install both packages. pi-fzfp detects the other editor via the
 *   "pi-fzfp:check-editor" handshake at session_start and skips
 *   addAutocompleteProvider. It announces wrapWithFuzzyFiles via
 *   "pi-fzfp:provider" so the other editor can wrap its own provider.
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { wrapWithFuzzyFiles } from "./provider.js";

export default function (pi: ExtensionAPI) {
	// Provide the wrapWithFuzzyFiles factory so other extensions (e.g. pi-vim)
	// can integrate with it.
	pi.events.emit("pi-fzfp:provider", wrapWithFuzzyFiles);

	pi.on("session_start", (_event, ctx) => {
		pi.events.emit("pi-fzfp:provider", wrapWithFuzzyFiles);

		// Handshake: ask if any other extension handles the editor.
		let editorHandled = false;
		pi.events.emit("pi-fzfp:check-editor", () => { editorHandled = true; });

		if (editorHandled) {
			// Another extension owns the editor — it picked up wrapWithFuzzyFiles
			// via the "pi-fzfp:provider" event emitted above.
			return;
		}

		// No custom editor extension — enhance the built-in autocomplete provider
		// instead of replacing the editor component. addAutocompleteProvider wraps
		// the existing provider chain without touching the editor or its layout,
		// keeping all footers and UI intact.
		ctx.ui.addAutocompleteProvider(
			(provider: AutocompleteProvider) => wrapWithFuzzyFiles(provider, ctx.cwd),
		);
	});
}
