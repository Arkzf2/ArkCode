import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type ShellConfiguration = Readonly<{ kind: "posix" | "powershell"; executable: string }>;

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function resolveShell(options: {
  executable?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
} = {}): ShellConfiguration {
  if (options.executable) {
    return { kind: /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(options.executable) ? "powershell" : "posix", executable: options.executable };
  }
  if ((options.platform ?? process.platform) !== "win32") return { kind: "posix", executable: "/bin/sh" };
  const env = options.env ?? process.env;
  const value = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const directories = (value("PATH") ?? "").split(";").map((path) => path.trim().replace(/^"(.*)"$/, "$1")).filter(isAbsolute);
  const roots: string[] = [];
  for (const directory of directories) {
    if (isFile(join(directory, "git.exe"))) roots.push(resolve(directory, ".."), resolve(directory, "../.."));
    if (isFile(join(directory, "bash.exe"))) {
      for (const root of [resolve(directory, ".."), resolve(directory, "../..")]) {
        if (isFile(join(root, "cmd", "git.exe")) || isFile(join(root, "mingw64", "bin", "git.exe"))) roots.push(root);
      }
    }
  }
  for (const name of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const directory = value(name);
    if (directory) roots.push(join(directory, "Git"));
  }
  const local = value("LOCALAPPDATA");
  if (local) roots.push(join(local, "Programs", "Git"));
  for (const root of new Set(roots)) {
    for (const relative of [join("bin", "bash.exe"), join("usr", "bin", "bash.exe")]) {
      const executable = join(root, relative);
      if (isFile(executable)) return { kind: "posix", executable };
    }
  }
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    const executable = directories.map((directory) => join(directory, name)).find(isFile);
    if (executable) return { kind: "powershell", executable };
  }
  const systemRoot = value("SystemRoot");
  return { kind: "powershell", executable: systemRoot ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe" };
}

export function shellInstructions(shell: ShellConfiguration, platform = process.platform): string {
  const name = shell.kind === "powershell" ? "PowerShell" : /(?:^|[\\/])bash(?:\.exe)?$/i.test(shell.executable) ? "Bash" : "POSIX shell";
  const syntax = shell.kind === "powershell"
    ? "Use PowerShell syntax and quoting for bash tool commands, including $env:NAME for environment variables. Bash syntax is unavailable unless you explicitly invoke a Bash executable."
    : "Use POSIX shell syntax and quoting for bash tool commands, including $NAME for environment variables. PowerShell cmdlets and PowerShell syntax require explicitly invoking PowerShell.";
  const paths = platform === "win32" && shell.kind === "posix"
    ? "\nThis is Git Bash on Windows. Use /c/path or C:/path and quote paths containing spaces. Native Windows programs may require Windows paths."
    : "";
  return `The bash tool executes ${name} at ${JSON.stringify(shell.executable)}.\n${syntax}${paths}\nThis is the current shell configuration and supersedes shell instructions in earlier history.`;
}
