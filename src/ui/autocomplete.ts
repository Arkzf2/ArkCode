import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  CombinedAutocompleteProvider,
  stripTerminalSequences,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { slashCommands } from "./commands.js";
import { toolModeSchema } from "../tools/mode.js";
import { workspacePath } from "../tools/workspace.js";
import type { Status } from "../app/types.js";
import { accent, directoryText } from "./colors.js";
import type { FileSelection } from "./file-attachments.js";

const ignoredDirectories = new Set([".git", ".arkcode", "node_modules"]);

export function mentionPrefix(beforeCursor: string): string | null {
  return /(?:^|[\s([{])(@(?:"[^"]*|[^\s"<>`]*))$/u.exec(beforeCursor)?.[1] ?? null;
}

export class WorkspaceAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["@"];
  private readonly commands: CombinedAutocompleteProvider;

  constructor(private readonly cwd: string, mcpServers: () => readonly string[] = () => [], private readonly skills: () => NonNullable<Status["skills"]> = () => [], private readonly selectFile?: (selection: FileSelection) => void) {
    this.commands = new CombinedAutocompleteProvider(slashCommands.map((command) => command.name === "tool-mode" ? {
      ...command, getArgumentCompletions: (prefix: string) => toolModeSchema.options.filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    } : command.name === "web-search" ? {
      ...command, getArgumentCompletions: (prefix: string) => ["status", "check", "on", "off"].filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    } : command.name === "skills" ? {
      ...command, getArgumentCompletions: (prefix: string) => {
        const match = /^(enable|disable)\s+(\S*)$/.exec(prefix);
        return (match ? this.skills().filter((skill) => skill.name.startsWith(match[2] ?? "")).map((skill) => `${match[1]} ${skill.name}`)
          : ["list", "enable", "disable", "reload"].filter((name) => name.startsWith(prefix))).map((value) => ({ value, label: value }));
      },
    } : command.name !== "mcp" ? command : {
      ...command,
      getArgumentCompletions: (prefix: string) => {
        const exposure = /^exposure\s+(\S+)\s+(\S*)$/.exec(prefix);
        if (exposure) return ["codemode", "deferred", "direct", "hidden"].filter((mode) => mode.startsWith(exposure[2] ?? ""))
          .map((mode) => ({ value: `exposure ${exposure[1]} ${mode}`, label: mode }));
        const match = /^(tools|reconnect|enable|disable|login|logout|exposure)\s+(\S*)$/.exec(prefix);
        const names = match ? mcpServers().filter((name) => name.startsWith(match[2] ?? "")).map((name) => `${match[1]} ${name}`)
          : ["help", "status", "tools", "reload", "reconnect", "enable", "disable", "login", "logout", "exposure"].filter((name) => name.startsWith(prefix));
        return names.map((value) => ({ value, label: value }));
      },
    }), cwd);
  }

  async getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<AutocompleteSuggestions | null> {
    const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const prefix = mentionPrefix(beforeCursor);
    if (!prefix) return this.commands.getSuggestions(lines, cursorLine, cursorCol, options);

    const quoted = prefix.startsWith('@"');
    const query = (quoted ? prefix.slice(2) : prefix.slice(1)).replace(/\\/g, "/");
    const skillQuery = query.replace(/^skill:/, "").toLowerCase();
    const skillItems: AutocompleteItem[] = quoted || query.includes("/") ? [] : this.skills()
      .filter((skill) => !skillQuery || `${skill.name} ${skill.description}`.toLowerCase().includes(skillQuery))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(skillQuery)) - Number(a.name.toLowerCase().startsWith(skillQuery)) || a.name.localeCompare(b.name))
      .slice(0, 8).map((skill) => ({ value: `@skill:${skill.name}`, label: accent(`Skill · ${stripTerminalSequences(skill.name)}`), description: `${skill.scope} · ${stripTerminalSequences(skill.description)}` }));
    if (query.startsWith("skill:")) return skillItems.length ? { items: skillItems, prefix } : null;
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
      return { value, label: directoryText(`${path.split("/").at(-1)}${directory ? "/" : ""}`), description: target };
    });
    const combined = [...skillItems, ...items];
    return combined.length ? { items: combined, prefix } : null;
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
    const result = this.commands.applyCompletion(lines, cursorLine, cursorCol, { ...item, label: stripTerminalSequences(item.label) }, prefix);
    if (prefix.startsWith("@") && item.value.startsWith("@") && !item.value.startsWith("@skill:") && item.description && !item.description.endsWith("/")) {
      const start = lines.slice(0, cursorLine).reduce((length, line) => length + line.length + 1, 0) + cursorCol - prefix.length;
      this.selectFile?.({ text: result.lines.join("\n"), path: item.description, start, end: start + item.value.length });
    }
    return result;
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.commands.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}
