import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { slashCommands } from "./commands.js";
import { workspacePath } from "./tools.js";

const ignoredDirectories = new Set([".git", ".arkcode", "node_modules"]);

export function mentionPrefix(beforeCursor: string): string | null {
  return /(?:^|[\s([{])(@(?:"[^"]*|[^\s"<>`]*))$/u.exec(beforeCursor)?.[1] ?? null;
}

export class WorkspaceAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["@"];
  private readonly commands: CombinedAutocompleteProvider;

  constructor(private readonly cwd: string) {
    this.commands = new CombinedAutocompleteProvider(slashCommands, cwd);
  }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const prefix = mentionPrefix(beforeCursor);
    if (!prefix) return this.commands.getSuggestions(lines, cursorLine, cursorCol, options);

    const quoted = prefix.startsWith('@"');
    const query = (quoted ? prefix.slice(2) : prefix.slice(1)).replace(/\\/g, "/");
    if (query.startsWith("/") || query.split("/").includes("..") || /^[A-Za-z]:/.test(query)) return null;
    const slash = query.lastIndexOf("/");
    const scope = slash < 0 ? "" : query.slice(0, slash + 1);
    const name = slash < 0 ? query : query.slice(slash + 1);
    try { await workspacePath(this.cwd, scope || "."); }
    catch { return null; }
    const queue = [scope];
    const matches: Array<{ path: string; directory: boolean; score: number }> = [];
    let visited = 0;
    while (queue.length && visited < 4000 && !options.signal.aborted) {
      const directory = queue.shift()!;
      let entries;
      try { entries = await readdir(join(this.cwd, directory), { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (++visited > 4000 || options.signal.aborted) break;
        if (entry.isSymbolicLink() || entry.name.startsWith(".env") || entry.name.includes('"') || /[\r\n]/.test(entry.name) || ignoredDirectories.has(entry.name)) continue;
        const isDirectory = entry.isDirectory();
        if (!isDirectory && !entry.isFile()) continue;
        const path = `${directory}${entry.name}`;
        const lower = path.toLowerCase();
        const needle = name.toLowerCase();
        const score = !needle ? 1 : entry.name.toLowerCase().startsWith(needle) ? 3 : lower.includes(needle) ? 2 : 0;
        if (score) matches.push({ path, directory: isDirectory, score });
        if (isDirectory && !scope && needle && path.split("/").length < 8) queue.push(`${path}/`);
      }
    }
    matches.sort((a, b) => b.score - a.score || Number(b.directory) - Number(a.directory) || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
    const items: AutocompleteItem[] = matches.slice(0, 20).map(({ path, directory }) => {
      const target = `${path}${directory ? "/" : ""}`;
      const value = quoted || /\s/.test(target) ? `@"${target}"` : `@${target}`;
      return { value, label: `${path.split("/").at(-1)}${directory ? "/" : ""}`, description: target };
    });
    return items.length ? { items, prefix } : null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    return this.commands.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.commands.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
