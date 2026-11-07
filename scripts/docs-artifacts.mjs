import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { HELP } from "../src/app/args.ts";
import { arkConfigSchema } from "../src/config/settings.ts";
import { slashCommands } from "../src/ui/commands.ts";
import { createTools } from "../src/tools/index.ts";
import { ManagedShell } from "../src/tools/shell.ts";
import { locales, pageNavigation } from "./docs-locales.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));

export async function cliOptions() {
  const source = ts.createSourceFile("args.ts", await readFile(new URL("../src/app/args.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let options;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "parseArgs") {
      const input = node.arguments[0];
      if (input && ts.isObjectLiteralExpression(input)) {
        const property = input.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText(source) === "options");
        if (property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) options = property.initializer;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!options) throw new Error("Cannot locate parseArgs options. Update the documentation extractor.");
  return options.properties.map(property => {
    if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) throw new Error("Unsupported CLI declaration.");
    const fields = Object.fromEntries(property.initializer.properties.map(field => {
      if (!ts.isPropertyAssignment(field)) throw new Error("Unsupported CLI option field.");
      const value = ts.isStringLiteral(field.initializer) ? field.initializer.text
        : field.initializer.kind === ts.SyntaxKind.TrueKeyword ? true
          : field.initializer.kind === ts.SyntaxKind.FalseKeyword ? false : undefined;
      if (value === undefined) throw new Error("Unsupported CLI option field.");
      return [field.name.getText(source), value];
    }));
    return { name: ts.isStringLiteral(property.name) ? property.name.text : property.name.getText(source), ...fields };
  });
}

export async function documentationArtifacts() {
  const banner = {
    en: "Generated from the actual definitions. Do not edit by hand. Regenerate with `npm run docs:generate`.\n\n",
    zh: "由实际定义生成，请勿手工修改。更新命令：`npm run docs:generate`。\n\n",
  };
  const options = await cliOptions();
  const defaults = arkConfigSchema.parse({});
  const cwd = root;
  const tools = createTools({ cwd, shell: new ManagedShell(cwd, "bash"), authorize: async () => false });
  const cliHelp = (lang) => `# ${lang === "zh" ? "CLI 帮助快照" : "CLI help snapshot"}\n\n${banner[lang]}\`\`\`text\n${HELP.trimEnd()}\n\`\`\`\n\n## ${lang === "zh" ? "解析器参数" : "Parser options"}\n\n| ${lang === "zh" ? "参数" : "Option"} | ${lang === "zh" ? "类型" : "Type"} | ${lang === "zh" ? "短名" : "Short name"} |\n| --- | --- | --- |\n${options.map(option => `| \`--${option.name}\` | ${option.type}${option.multiple ? "[]" : ""} | ${option.short ? `\`-${option.short}\`` : lang === "zh" ? "无" : "-"} |`).join("\n")}\n`;
  const commands = (lang) => `# ${lang === "zh" ? "交互命令目录" : "Interactive command directory"}\n\n${banner[lang]}| ${lang === "zh" ? "命令" : "Command"} | ${lang === "zh" ? "描述" : "Description"} |\n| --- | --- |\n${slashCommands.map(command => `| \`/${command.name}\` | ${command.description} |`).join("\n")}\n`;
  const settings = (lang) => `# ${lang === "zh" ? "Settings 默认值" : "Settings defaults"}\n\n${banner[lang]}| ${lang === "zh" ? "字段" : "Field"} | ${lang === "zh" ? "默认值" : "Default"} |\n| --- | --- |\n${Object.keys(arkConfigSchema.shape).map(key => `| \`${key}\` | ${key in defaults ? `\`${JSON.stringify(defaults[key])}\`` : lang === "zh" ? "未设置" : "unset"} |`).join("\n")}\n`;
  const artifacts = new Map();
  for (const locale of locales) {
    const lang = locale === "zh-CN" ? "zh" : "en";
    for (const [filename, content] of [["cli-help", cliHelp(lang)], ["commands", commands(lang)], ["settings-defaults", settings(lang)]]) {
      const name = `docs/${locale}/reference/generated/${filename}.md`;
      artifacts.set(name, content.replace(/^(# [^\n]+\n\n)/, `$1${pageNavigation(name)}\n\n`));
    }
  }
  artifacts.set("docs/shared/generated/tool-inputs.json", JSON.stringify({ tools: tools.map(tool => ({ name: tool.name, inputSchema: tool.parameters })) }, null, 2) + "\n");
  return artifacts;
}
