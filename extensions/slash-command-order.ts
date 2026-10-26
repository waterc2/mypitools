import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

// Prioritize the most frequently used slash commands while preserving the
// relative order and behavior of every other suggestion.
const PRIORITY = ["model", "new", "thinking", "retry", "resume"];
const PRIORITY_INDEX = new Map(PRIORITY.map((name, index) => [name, index]));

function orderSlashCommands(current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions || !suggestions.prefix.trimStart().startsWith("/")) {
        return suggestions;
      }

      const items = suggestions.items.map((item, index) => ({ item, index }));
      items.sort((a, b) => {
        const aName = a.item.value.replace(/^\/+/, "").split(/[\s/]/, 1)[0];
        const bName = b.item.value.replace(/^\/+/, "").split(/[\s/]/, 1)[0];
        const aPriority = PRIORITY_INDEX.get(aName) ?? PRIORITY.length;
        const bPriority = PRIORITY_INDEX.get(bName) ?? PRIORITY.length;
        return aPriority - bPriority || a.index - b.index;
      });
      return { ...suggestions, items: items.map(({ item }) => item) };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(orderSlashCommands);
  });
}
