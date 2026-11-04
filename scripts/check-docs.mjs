import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Compile } from "typebox/compile";
import { arkConfigSchema } from "../src/config/settings.ts";
import { loadMcpConfig } from "../src/integrations/mcp/config.ts";
import { TOOL_NAMES } from "../src/tools/index.ts";
import { slashCommands } from "../src/ui/commands.ts";
import { COMPACT_PROMPT, COMPACT_RETRY_PROMPT, SUMMARY_PREFIX } from "../src/compaction/prompts.ts";
import { cliOptions, documentationArtifacts, root } from "./docs-artifacts.mjs";
import { counterpart, locales, pageLocale, pageNavigation } from "./docs-locales.mjs";

const normalize = value => value.replaceAll("\r\n", "\n");
const slash = value => value.split(sep).join("/");
async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(name));
    else if (entry.isFile()) result.push(name);
  }
  return result;
}

const products = [join(root, "README.md"), join(root, "README-CN.md"), join(root, "CONTRIBUTING.md"), ...await files(join(root, "docs"))];
const pages = new Map();
for (const file of products.filter(name => name.endsWith(".md"))) {
  const content = normalize(await readFile(file, "utf8"));
  const blocks = [];
  const prose = content.replace(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^\1[ \t]*$/gm, (_block, _fence, language, code) => {
    blocks.push({ language: language.trim(), code });
    return "";
  });
  assert(!/^\s{0,3}(?:`{3,}|~{3,})/m.test(prose), `Unclosed code fence: ${relative(root, file)}`);
  const anchors = new Set();
  const counts = new Map();
  for (const match of prose.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const name = match[1].replace(/`/g, "").toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").trim().replace(/ /g, "-");
    const count = counts.get(name) ?? 0;
    anchors.add(name + (count ? `-${count}` : ""));
    counts.set(name, count + 1);
  }
  pages.set(file, { content, prose, blocks, anchors });
}

const neutralPages = new Set(["CONTRIBUTING.md", "docs/README.md"]);
let pairs = 0;
for (const [file, page] of pages) {
  const name = slash(relative(root, file));
  if (neutralPages.has(name)) continue;
  const locale = pageLocale(name);
  assert(locale, `Markdown page outside a language directory: ${name}`);
  assert(!name.startsWith("docs/") || !name.endsWith("-CN.md"), `Use the same filename in both languages: ${name}`);
  assert(pages.has(join(root, counterpart(name))), `Missing language counterpart for ${name}: ${counterpart(name)}`);
  assert.equal(page.content.split("\n")[2], pageNavigation(name), `Missing or incorrect language navigation in ${name}`);
  if (locale === "en") pairs++;
}
for (const file of products) {
  const name = slash(relative(root, file));
  assert(!name.startsWith("docs/") || name === "docs/README.md" || locales.some(locale => name.startsWith(`docs/${locale}/`)) || name.startsWith("docs/shared/"), `Unexpected document location: ${name}`);
  assert(name.endsWith(".md") || name.startsWith("docs/shared/"), `Store language-independent artifacts in docs/shared/: ${name}`);
}

const links = [];
for (const [file, page] of pages) {
  for (const match of page.prose.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)\)/g)) {
    const href = match[1].replace(/^<|>$/g, "");
    if (/^(?:https?:|mailto:)/i.test(href)) continue;
    assert(!/^(?:[A-Za-z]:|\/|\\|file:)/.test(href), `Local absolute link in ${relative(root, file)}: ${href}`);
    const [pathname, anchor] = href.split("#");
    const target = resolve(dirname(file), decodeURIComponent(pathname || basename(file)));
    const local = relative(root, target);
    assert(!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`), `Link escapes repository: ${href}`);
    assert(!/^(?:maintainers|research)(?:\/|$)/.test(slash(local)), `Product link depends on ignored material: ${href}`);
    assert((await stat(target).catch(() => null))?.isFile(), `Missing target in ${relative(root, file)}: ${href}`);
    let cursor = root;
    for (const segment of local.split(sep)) {
      assert((await readdir(cursor)).includes(segment), `Link case mismatch: ${href}`);
      cursor = join(cursor, segment);
    }
    if (anchor && pages.has(target)) assert(pages.get(target).anchors.has(decodeURIComponent(anchor)), `Missing anchor in ${relative(root, file)}: ${href}`);
    const from = slash(relative(root, file)), to = slash(local);
    const fromLocale = pageLocale(from), toLocale = pageLocale(to);
    if (fromLocale && toLocale && fromLocale !== toLocale) {
      assert.equal(to, counterpart(from), `Cross-language content link in ${from}: ${href}. Only the matching language switch may cross languages.`);
    }
    links.push({ from, to });
  }
}

const reachable = new Set(["README.md"]);
for (let size = -1; size !== reachable.size;) {
  size = reachable.size;
  for (const link of links) if (reachable.has(link.from)) reachable.add(link.to);
}
for (const file of products) assert(reachable.has(slash(relative(root, file))), `Unlinked product document: ${relative(root, file)}`);

for (const locale of locales) {
  const localReachable = new Set([`docs/${locale}/README.md`]);
  for (let size = -1; size !== localReachable.size;) {
    size = localReachable.size;
    for (const link of links) {
      if (localReachable.has(link.from) && (pageLocale(link.to) === locale || link.to.startsWith("docs/shared/"))) localReachable.add(link.to);
    }
  }
  for (const file of products) {
    const name = slash(relative(root, file));
    if (name.startsWith(`docs/${locale}/`) || name.startsWith("docs/shared/")) assert(localReachable.has(name), `Document unreachable from ${locale} docs home: ${name}`);
  }
}

for (const [name, content] of await documentationArtifacts()) {
  assert.equal(normalize(await readFile(join(root, name), "utf8")), content, `Stale generated reference: ${name}. Run npm run docs:generate.`);
}
for (const locale of locales) {
  const cli = pages.get(join(root, `docs/${locale}/reference/cli.md`)).content;
  for (const option of await cliOptions()) assert(cli.includes(`--${option.name}\``), `${locale} CLI reference omits --${option.name}`);
  const commands = pages.get(join(root, `docs/${locale}/reference/commands.md`)).content;
  for (const command of slashCommands) assert(commands.includes(`\`/${command.name}`), `${locale} command reference omits /${command.name}`);
  const config = pages.get(join(root, `docs/${locale}/reference/configuration.md`)).content;
  for (const name of Object.keys(arkConfigSchema.shape)) assert(config.includes(`\`${name}\``), `${locale} configuration reference omits ${name}`);
  const tools = pages.get(join(root, `docs/${locale}/reference/tools.md`)).content;
  for (const name of TOOL_NAMES) assert(tools.includes(`\`${name}\``) || tools.includes(`## ${name}`), `${locale} tool reference omits ${name}`);
  const prompts = pages.get(join(root, `docs/${locale}/reference/compaction-prompts.md`)).blocks.filter(block => block.language === "text").map(block => block.code.replace(/\n$/, ""));
  assert.deepEqual(prompts, [COMPACT_PROMPT, SUMMARY_PREFIX, COMPACT_RETRY_PROMPT], `${locale} compaction prompt contract differs from runtime.`);
}

const modelSchema = Compile(JSON.parse(await readFile(new URL("../schemas/models.schema.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8")));
const temporary = await mkdtemp(join(tmpdir(), "arkcode-doc-examples-"));
assert(dirname(temporary) === resolve(tmpdir()) && basename(temporary).startsWith("arkcode-doc-examples-"));
let examples = 0;
try {
  await mkdir(join(temporary, "workspace"));
  for (const [file, page] of pages) for (const block of page.blocks.filter(item => item.language === "json")) {
    const example = JSON.parse(block.code);
    if ("mcpServers" in example) {
      await writeFile(join(temporary, "mcp.json"), block.code);
      const loaded = loadMcpConfig({ home: temporary, cwd: join(temporary, "workspace"), trusted: false });
      assert.deepEqual(loaded.diagnostics, [], `Invalid MCP example: ${relative(root, file)}`);
      assert.equal(loaded.entries.length, Object.keys(example.mcpServers).length);
    } else if ("providers" in example) assert(modelSchema.Check(example), `Invalid models example: ${relative(root, file)}`);
    else if ("permission" in example || "thinking" in example) arkConfigSchema.parse(example);
    examples++;
  }
} finally { await rm(temporary, { recursive: true, force: true }); }

const npm = process.env.npm_execpath;
assert(npm, "Run this checker with npm run docs:check so the configured npm executable is available.");
const [pack] = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
const packed = new Set(pack.files.map(file => file.path));
for (const file of products) assert(packed.has(slash(relative(root, file))), `Product document missing from npm package: ${relative(root, file)}`);
for (const link of links) assert(packed.has(link.to), `Package link from ${link.from} misses ${link.to}`);
assert(![...packed].some(name => /^(?:maintainers|research)\//.test(name)), "Ignored notes leaked into the package.");
for (const required of ["scripts/patch-pi-sdk.mjs", "scripts/pi-sdk-patch/manifest.json", "dist/cli.js"]) assert(packed.has(required), `Missing install/build artifact: ${required}`);
await import("./shell-schemas.mjs?check");
console.log(`Checked ${pairs} language pairs, ${pages.size} Markdown pages, ${links.length} local links, ${examples} JSON examples, generated references and npm package contents.`);
