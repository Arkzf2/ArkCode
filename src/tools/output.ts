export function cleanOutput(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function createOutputCleaner(): (text: string) => string {
  let state: "text" | "escape" | "csi" | "osc" | "osc_escape" = "text";
  return (text) => {
    let output = "";
    for (const char of text) {
      switch (state) {
        case "text":
          if (char === "\x1b") state = "escape";
          else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(char)) output += char;
          break;
        case "escape": state = char === "[" ? "csi" : char === "]" ? "osc" : "text"; break;
        case "csi": if (char >= "@" && char <= "~") state = "text"; break;
        case "osc": if (char === "\x07") state = "text"; else if (char === "\x1b") state = "osc_escape"; break;
        case "osc_escape": state = char === "\\" ? "text" : "osc"; break;
      }
    }
    return output;
  };
}
