/**
 * Fuzzy File Picker Extension (fzf-powered)
 *
 * Enhances pi's @file autocomplete using fd + fzf --filter.
 *
 * ## Standalone mode (no custom editor extension):
 *   pi -e ~/tools/fuzzy-file-picker/index.ts
 *
 * ## With pi-vim or another custom editor:
 *   Don't load this extension directly. Instead, import the provider wrapper
 *   in your custom editor:
 *
 *   import { wrapWithFuzzyFiles } from "~/tools/fuzzy-file-picker/provider.js";
 *
 *   class MyEditor extends CustomEditor {
 *     override setAutocompleteProvider(provider: AutocompleteProvider) {
 *       super.setAutocompleteProvider(wrapWithFuzzyFiles(provider));
 *     }
 *   }
 *
 *   See provider.ts for the reusable API.
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
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new FuzzyFileEditor(tui, theme, kb));
	});
}
