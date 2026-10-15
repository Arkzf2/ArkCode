import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const color = (red: number, green: number, blue: number) => (text: string) => `\x1b[38;2;${red};${green};${blue}m${text}\x1b[0m`;
export const toolColors = {
  success: color(68, 211, 116),
  error: color(242, 139, 145),
  output: color(145, 146, 154),
  command: color(229, 231, 235),
  executable: color(143, 190, 255),
  flag: color(225, 160, 204),
  string: color(201, 190, 139),
  operator: color(174, 175, 189),
  variable: color(178, 165, 231),
  path: color(157, 203, 211),
};

export function highlightCommand(command: string): string {
  let executable = true;
  let comment = false;
  return (command.match(/(?:"(?:`.|\\.|[^"\\])*"|'(?:''|[^'])*'|[^\s|;&<>"'])+|[|;&<>]+|\s+|["']/g) ?? []).map((token) => {
    if (/^\s+$/.test(token)) {
      if (token.includes("\n")) { executable = true; comment = false; }
      return token;
    }
    if (comment) return toolColors.output(token);
    if (/^[|;&<>]+$/.test(token)) {
      executable = true;
      return toolColors.operator(token);
    }
    if (token.startsWith("#")) { comment = true; return toolColors.output(token); }
    if (/^[\w]+=[^=]/.test(token) && executable) return toolColors.variable(token);
    if (executable) { executable = false; return toolColors.executable(token); }
    if (/^["']/.test(token)) return toolColors.string(token);
    if (/^-/.test(token)) return toolColors.flag(token);
    if (/\$|^%\w+%$/.test(token)) return toolColors.variable(token);
    if (/[/\\]/.test(token)) return toolColors.path(token);
    return toolColors.command(token);
  }).join("");
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    else if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

export function renderDiff(diff: string, width: number): string[] {
  return diff.split("\n").flatMap((line) => {
    const match = /^([+\- ])(\s*\d+ )(.*)$/.exec(line);
    if (!match) return wrapTextWithAnsi(toolColors.output(line), width);
    const [, sign = " ", number = "", content = ""] = match;
    const paint = sign === "+" ? toolColors.success : sign === "-" ? toolColors.error : toolColors.output;
    const gutter = sign + number;
    if (width <= gutter.length) return wrapTextWithAnsi(paint(line), width);
    return wrapTextWithAnsi(paint(content), width - gutter.length).map((part, index) =>
      `${index === 0 ? paint(gutter) : " ".repeat(gutter.length)}${part}`);
  });
}
