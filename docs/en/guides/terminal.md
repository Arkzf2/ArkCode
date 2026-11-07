# Work in the terminal

English | [简体中文](../../zh-CN/guides/terminal.md) | [Docs home](../README.md)

## Submit, correct, and queue

Press Enter when idle to submit a task. While a task runs, press Enter to send a steer that adds to or corrects the current task; press Tab to add a new task to the follow-up queue, which continues after the current task ends. Shift+Left edits queue input that has not been consumed.

Enter `@` to search workspace files and enabled Skills. Selecting a file inserts its path and registers an explicit attachment; paths with spaces keep quotes. Selected images are sent as image parts; text files remain path references. Editing or deleting a selected path removes its attachment. Typing or pasting `@file.png`, `@defer`, or `@Ident` directly keeps the text literal. Selecting a Skill inserts `@skill:name`; see the [Skills guide](skills.md).

To run a shell command yourself, type `!` followed by the command. The command uses the shell selected for the current session and goes through the matching approval. It does not turn the terminal into an interactive shell.

## View tools and history

Tool output shows a short preview by default. Click `+N lines` to expand the current result and `Show less` to collapse it. Ctrl+T toggles all tool details and model-provided reasoning. write and edit show file change previews; a large write may show only the execution result.

Use the scroll wheel or PgUp/PgDn to browse history; End returns to the latest content. Ctrl+L clears the view without deleting history. The status bar shows model, reasoning level, directory, permissions, and Git branch; the context line shows used tokens, window, and percent. `~` means an estimate, and `?` means new usage has not arrived.

## Copy and edit

Drag with the mouse to select transcript text; release to copy. With an existing selection, Ctrl+C copies and Esc clears the selection. Shift+drag uses the terminal's own selection. Ctrl+O or `/copy` copies the last complete answer.

Ctrl+R searches prompt history. Ctrl+G edits the draft with `VISUAL` or `EDITOR`. Double Esc in an empty composer edits the previous prompt and creates a fork; files are not rolled back.

## Interrupt and exit

Esc interrupts the current task and returns one level in a panel. Without a selection, Ctrl+C interrupts during a run and exits when idle. Ctrl+D exits in an empty composer. `/exit` stops all sessions and managed processes owned by this terminal.

Interruption keeps tool effects that already completed. Forcefully ending the host also does not guarantee that external processes or MCP server operations stopped; see [Troubleshooting](../troubleshooting.md) for abnormal recovery. For the full key and slash syntax, see the [Interactive commands reference](../reference/commands.md).
