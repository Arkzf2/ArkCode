import assert from "node:assert/strict";
import test from "node:test";
import { inspectShell } from "../src/permissions/shell-policy.js";

test("POSIX inspection follows nested commands and Kimi's finite danger rules without executing input", async () => {
  for (const command of ["shutdown now", "sudo -u root reboot", "sudo -n rm -rf /important", "env -C /tmp X=1 rm -rf /important", "echo $(shutdown now)", "echo `reboot`", "bash -lc 'rm -rf /important'", "eval 'shutdown now'", "busybox rm -rf /important", "dd if=/dev/zero of=/dev/sda", "mkfs.ext4 /dev/sda", "systemctl --host host reboot"]) {
    assert.ok((await inspectShell(command, "/bin/sh")).dangerous, command);
  }
  for (const command of ["npm test", "git status", "git reset --hard", "python script.py", "rm -rf /tmp/generated", "rm -- -rf /important", "systemctl --host reboot status", "dd of=/dev/stdout", "echo 'shutdown now'", "command -v reboot"]) {
    assert.equal((await inspectShell(command, "/bin/sh")).dangerous, null, command);
  }
  for (const command of ["rm -rf /tmp/$target", "rm -rf /tmp/*", "rm -rf /tmp/../important", "rm -rf /tmp/generated /important"]) {
    assert.ok((await inspectShell(command, "/bin/sh")).dangerous, command);
  }
  assert.equal((await inspectShell("cat <<'EOF'\nshutdown now\nEOF", "/bin/sh")).analyzable, false);
  assert.equal((await inspectShell("echo '", "/bin/sh")).analyzable, false);
});

test("Always Ask listing exemption excludes command substitutions, writes and command chains", async () => {
  for (const command of ["ls", "ls -la 'directory with spaces'", "ls src/*.ts"]) assert.equal((await inspectShell(command, "/bin/sh")).listing, true, command);
  for (const command of ["ls; echo side-effect", "ls > output.txt", "ls | tee output.txt", "ls $(echo path)", "ls `echo path`", "X=1 ls", "if true; then ls; fi"]) assert.equal((await inspectShell(command, "/bin/sh")).listing, false, command);
});

test("native PowerShell AST handles listings, aliases, recursive force flags and nested commands", { skip: process.platform !== "win32" }, async () => {
  for (const command of ["ls", "Get-ChildItem -Path 'a b'"]) assert.equal((await inspectShell(command, "powershell.exe")).listing, true, command);
  for (const command of ["ls; Set-Content file.txt value", "ls > file.txt", "ls $(Get-Date)", "& ls", "ls | Out-File file.txt"]) assert.equal((await inspectShell(command, "powershell.exe")).listing, false, command);
  for (const command of ["Remove-Item C:\\important -Force", "Remove-Item C:\\important -Recurse", "Remove-Item C:\\important -Recurse:$false -Force", "Write-Output 'Restart-Computer'"]) assert.equal((await inspectShell(command, "powershell.exe")).dangerous, null, command);
  for (const command of ["Remove-Item C:\\important -Recurse -Force", "rm C:\\important -r -fo", "Write-Output $(Restart-Computer)", "iex 'Restart-Computer'", "powershell -Command 'Restart-Computer'", "Format-Volume -DriveLetter Z"]) assert.ok((await inspectShell(command, "powershell.exe")).dangerous, command);
});
