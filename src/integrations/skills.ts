import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { formatSkillsForPrompt, loadSkills, stripFrontmatter, type ExtensionFactory, type Skill } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const policySchema = z.object({ version: z.literal(1), disabledPaths: z.array(z.string()) }).strict();
const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export interface SkillItem { name: string; description: string; path: string; scope: "user" | "project"; enabled: boolean; shadowed: boolean }
type Entry = { skill: Skill; path: string; root: string; scope: SkillItem["scope"] };

export class SkillsManager {
  private entries: Entry[] = [];
  private disabled = new Set<string>();
  private warnings: string[] = [];
  readonly roots: string[] = [];
  constructor(private options: { home: string; cwd: string; trusted: boolean; userHome?: string }) { this.reload(); }

  private policyPath(): string { return join(this.options.home, "skills.json"); }
  refresh(): void {
    const path = this.policyPath();
    try {
      const policy = existsSync(path) ? policySchema.parse(JSON.parse(readFileSync(path, "utf8"))) : { disabledPaths: [] };
      this.disabled = new Set(policy.disabledPaths.map(key));
    } catch (error) { throw new Error(`Cannot load Skill preferences at ${path}.`, { cause: error }); }
  }
  reload(): void {
    const roots: Array<{ path: string; scope: SkillItem["scope"] }> = [];
    if (this.options.trusted) {
      const ancestors: string[] = [];
      let directory = resolve(this.options.cwd);
      for (;;) {
        ancestors.push(directory);
        if (existsSync(join(directory, ".git"))) break;
        const parent = dirname(directory);
        if (parent === directory) { ancestors.splice(1); break; }
        directory = parent;
      }
      roots.push(...ancestors.map((path) => ({ path: join(path, ".agents", "skills"), scope: "project" as const })));
    }
    roots.push({ path: join(this.options.userHome ?? homedir(), ".agents", "skills"), scope: "user" });
    const entries: Entry[] = [];
    const seen = new Set<string>();
    const warnings: string[] = [];
    for (const root of roots) {
      if (!existsSync(root.path)) continue;
      const queue = [{ path: root.path, depth: 0 }];
      const visited = new Set<string>();
      while (queue.length && visited.size < 2000) {
        const current = queue.shift();
        if (!current) break;
        try {
          const directory = key(realpathSync(current.path));
          if (visited.has(directory)) continue;
          visited.add(directory);
          const manifest = join(current.path, "SKILL.md");
          if (!existsSync(manifest) || !statSync(manifest).isFile()) {
            if (current.depth < 8) for (const child of readdirSync(current.path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
              if (!child.name.startsWith(".") && child.name !== "node_modules" && (child.isDirectory() || child.isSymbolicLink())) {
                const path = join(current.path, child.name);
                try { if (statSync(path).isDirectory()) queue.push({ path, depth: current.depth + 1 }); }
                catch (error) { warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
              }
            }
            continue;
          }
          if (statSync(manifest).size > 2 * 1024 * 1024) { warnings.push(`${manifest}: Skill exceeds the 2 MiB limit.`); continue; }
          const loaded = loadSkills({ cwd: this.options.cwd, agentDir: join(this.options.userHome ?? homedir(), ".agents"), skillPaths: [manifest], includeDefaults: false });
          warnings.push(...loaded.diagnostics.map((item) => `${item.path}: ${item.message}`));
          for (const skill of loaded.skills) {
            if (/[\s@<>"\\/,;!?\[\](){}\x60\x00-\x1f\x7f-\x9f]/.test(skill.name)) { warnings.push(`${skill.filePath}: name cannot be used in a Skill mention.`); continue; }
            const path = realpathSync(skill.filePath);
            if (seen.has(key(path))) continue;
            seen.add(key(path));
            entries.push({ skill, path, root: realpathSync(skill.baseDir), scope: root.scope });
          }
        } catch (error) { warnings.push(`${current.path}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (queue.length) warnings.push(`${root.path}: Skill scan stopped at the 2000 directory limit.`);
    }
    this.refresh();
    this.entries = entries;
    this.warnings = warnings;
    this.roots.splice(0, this.roots.length, ...roots.map((root) => root.path));
  }
  get items(): SkillItem[] {
    const names = new Set<string>();
    return this.entries.map((entry) => {
      const enabled = !this.disabled.has(key(entry.path));
      const shadowed = enabled && names.has(entry.skill.name);
      if (enabled) names.add(entry.skill.name);
      return { name: entry.skill.name, description: entry.skill.description, path: entry.path, scope: entry.scope, enabled, shadowed };
    });
  }
  get available(): SkillItem[] { return this.items.filter((entry) => entry.enabled && !entry.shadowed); }
  get sdkSkills(): Skill[] {
    const paths = new Set(this.available.map((entry) => entry.path));
    return this.entries.filter((entry) => paths.has(entry.path)).map((entry) => entry.skill);
  }
  get resources() { return { skills: this.sdkSkills, diagnostics: [] }; }
  setEnabled(selector: string, enabled: boolean): void {
    this.refresh();
    const matches = this.items.filter((item) => item.path === selector || item.name === selector);
    if (matches.length !== 1 || !matches[0]) throw new Error(matches.length ? "Ambiguous Skill name. Use its full SKILL.md path." : `Unknown Skill: ${selector}`);
    const path = matches[0].path;
    const disabled = new Set(this.disabled);
    if (enabled) disabled.delete(key(path)); else disabled.add(key(path));
    mkdirSync(this.options.home, { recursive: true });
    const temporary = `${this.policyPath()}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, disabledPaths: [...disabled].sort() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.policyPath());
      this.disabled = disabled;
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  private selected(name: string): Entry {
    const item = this.available.find((item) => item.name === name);
    const entry = item && this.entries.find((entry) => entry.path === item.path);
    if (!entry) throw new Error(`Skill "${name}" is unavailable or disabled. Use /skills to inspect available Skills.`);
    return entry;
  }
  async prepare(text: string): Promise<string> {
    this.refresh();
    const command = /^\/skill:([^\s]+)(?:\s|$)/.exec(text);
    if (text.startsWith("/skill:") && !command) throw new Error("Use /skill:name followed by your task.");
    const names = new Set(command?.[1] ? [command[1]] : []);
    let fence = false;
    for (const line of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      const prose = line.replace(/`[^`]*`/g, "");
      if (/(?:^|[\s([{])@skill:(?=$|\s)/.test(prose)) throw new Error("Use @skill:name followed by your task.");
      for (const match of prose.matchAll(/(?:^|[\s([{])@skill:([^\s,;!?\])}]+)/g)) if (match[1]) names.add(match[1]);
    }
    if (names.size > 8) throw new Error("At most 8 Skills per input.");
    const blocks: string[] = [];
    for (const name of names) {
      const entry = this.selected(name);
      const file = await this.resolve(this.options.cwd, entry.skill.filePath);
      if (!file) throw new Error(`Skill disappeared: ${name}. Run /skills reload.`);
      const info = await stat(file);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error(`Skill is not a regular text file within the 2 MiB limit: ${name}`);
      const body = stripFrontmatter(await readFile(file, "utf8")).trim();
      blocks.push(`User activated the skill "${xml(name)}". Follow the loaded skill instructions.\n\n<skill-loaded name="${xml(name)}">\n${body}\n</skill-loaded>`);
    }
    return blocks.length ? `${blocks.join("\n\n")}\n\n${text}` : text;
  }
  async resolve(cwd: string, path: string): Promise<string | undefined> {
    const target = resolve(cwd, path);
    const lexical = this.entries.filter((entry) => inside(entry.skill.baseDir, target) || inside(entry.root, target));
    if (!lexical.length) return undefined;
    this.refresh();
    const entry = lexical.find((entry) => !this.disabled.has(key(entry.path)));
    if (!entry) throw new Error("This Skill is disabled.");
    const root = await realpath(entry.skill.baseDir);
    const actual = await realpath(target);
    const manifest = await realpath(entry.skill.filePath);
    if (key(root) !== key(entry.root) || key(manifest) !== key(entry.path) || !inside(root, actual)) throw new Error("Skill resource points outside its registered directory. Run /skills reload.");
    if (relative(root, actual).toLowerCase().split(/[\\/]/).some((part) => part === ".git" || part === ".arkcode" || part === ".env" || part.startsWith(".env."))) throw new Error("Protected files are unavailable as Skill resources.");
    return actual;
  }
  async read(cwd: string, path: string): Promise<Buffer | undefined> {
    const actual = await this.resolve(cwd, path);
    if (!actual) return undefined;
    const info = await stat(actual);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Skill resource exceeds the 2 MiB regular-file limit.");
    return readFile(actual);
  }
  readonly extension: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      this.refresh();
      const catalog = formatSkillsForPrompt(this.sdkSkills, "indirect").trim();
      event.systemPromptOptions.sections.skills = catalog
        ? `${catalog}\nA <skill-loaded> block contains the complete instructions of a user-activated Skill. Follow those instructions directly without loading its SKILL.md again. For other applicable Skills, load their SKILL.md through the currently available tool interface; read supporting resources only as needed. This list replaces earlier Skill lists. Disabled or omitted entries are no longer available for automatic selection. Skill instructions do not grant tool permissions.`
        : "No Skills are available for automatic selection. This replaces earlier Skill lists. Do not continue applying Skills removed or disabled from the list to new tasks.";
    });
  };
  statusText(): string {
    return ["Sources:", ...this.roots, "", ...this.items.map((item) => `${item.enabled ? "[x]" : "[ ]"} ${item.name} | ${item.scope}${item.shadowed ? " | shadowed" : ""}\n  ${item.path}\n  ${item.description}`),
      ...(this.warnings.length ? ["", "Diagnostics:", ...this.warnings] : []), this.items.length ? "" : "No Skills found."].join("\n");
  }
}
