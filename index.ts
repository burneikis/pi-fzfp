/**
 * Fuzzy File Picker Extension
 *
 * Enhances pi's @file autocomplete using an in-process fuzzy matcher
 * (nucleo-style scoring) with rg/fd for file discovery.
 *
 * ## Standalone mode (no other custom editor extension):
 *   Installs a FuzzyFileEditor as the editor component automatically.
 *
 * ## With pi-vim (or another custom editor):
 *   Install both packages. pi-fzfp detects a custom editor via the
 *   "pi-fzfp:check-editor" handshake at session_start and skips
 *   setEditorComponent. It announces wrapWithFuzzyFiles via "pi-fzfp:provider"
 *   so the other editor can wrap its own autocomplete provider.
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { wrapWithFuzzyFiles } from "./provider.js";

class FuzzyFileEditor extends CustomEditor {
	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
	}
}

export default function (pi: ExtensionAPI) {
	// Emit the provider immediately — catches any extensions that loaded before
	// us and are already listening.
	pi.events.emit("pi-fzfp:provider", wrapWithFuzzyFiles);

	pi.on("session_start", (_event, ctx) => {
		// Re-emit now that all extension factories have run, so extensions that
		// loaded after us and set up their listeners in their factory also get it.
		pi.events.emit("pi-fzfp:provider", wrapWithFuzzyFiles);

		// Ask if any other extension is handling the editor. All factory-time
		// listeners are guaranteed to be registered by now.
		let editorHandled = false;
		pi.events.emit("pi-fzfp:check-editor", () => { editorHandled = true; });

		if (!editorHandled) {
			ctx.ui.setEditorComponent((tui, theme, kb) => new FuzzyFileEditor(tui, theme, kb));
		}
	});
}
