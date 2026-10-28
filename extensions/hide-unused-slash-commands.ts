import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

// Hide these built-in commands from autocomplete and block their execution.
const HIDDEN_COMMANDS = new Set([
  "name",
  "reload",
  "logout",
  "login",
  "tree",
  "clone",
  "fork",
  "hotkeys",
  "changelog",
  "copy",
  "bug",
  "share",
  "import",
  "export",
  "scoped-models",
]);

function getCommandName(text: string): string | undefined {
  const match = text.trim().match(/^\/([^\s]+)/);
  return match?.[1];
}

function filterSlashCommandSuggestions(current: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: current.triggerCharacters,
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!suggestions || !suggestions.prefix.trimStart().startsWith("/")) {
        return suggestions;
      }

      const items = suggestions.items.filter((item) => {
        const commandName = item.value.replace(/^\/+/, "").split(/[\s/]/, 1)[0];
        return !HIDDEN_COMMANDS.has(commandName);
      });
      return items.length > 0 ? { ...suggestions, items } : null;
    },
    applyCompletion(
      lines: string[],
      cursorLine: number,
      cursorCol: number,
      item: AutocompleteItem,
      prefix: string,
    ) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(filterSlashCommandSuggestions);

    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "enter")) {
        return;
      }

      const commandName = getCommandName(ctx.ui.getEditorText());
      if (!commandName || !HIDDEN_COMMANDS.has(commandName)) {
        return;
      }

      ctx.ui.setEditorText("");
      ctx.ui.notify(`Blocked /${commandName}`, "info");
      return { consume: true };
    });
  });
}
