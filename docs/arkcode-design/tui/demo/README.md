# Rendering demo

Run `node ../build-demo.mjs` from this directory. The output is `../arkcode-tui-demo.html`, a standalone browser prototype.

`demo.js` owns fixed scene events, state transitions and rendering. Records keep stable IDs. Tools update in place. Reasoning summaries remain in the transcript. Pending instructions and follow-ups have separate delivery states. Reset and interruption invalidate scheduled callbacks.

Two shapes were considered. Complete scene snapshots made the initial samples shorter, but approval branches and interruption would multiply frames. Scripted events with one transition function preserve the same behavior across scenes. This prototype does not define the production Agent loop.

The Markdown renderer uses cumulative source. Finished content blocks render through Marked; the final unfinished block stays mutable. The browser batches at block boundaries. It does not implement Codex's native terminal line-commit controller or Unicode cell measurement. Code highlighting uses highlight.js and HTML is sanitized with DOMPurify. Copy preserves source text.

Vendored demonstration dependencies are Marked 15.0.12, highlight.js 11.11.1, DOMPurify 3.2.7, and Lucide static icons 0.468.0. License files are retained under `vendor`. These versions are pinned for the prototype, not a recommendation for production dependency selection.

All commands, results, file previews and review findings are fixtures. Local filesystem access, model access, OS sandboxing, history persistence and process stopping are outside this demo. Browser-reserved shortcuts may need the visible transcript button or `/copy` command.

Model, reasoning effort, directory, permissions, branch and context usage stay below the composer in every scene and view. The context fixture is 36,000 of 200,000 tokens, or 18% used. There is no repeated startup metadata or default send/newline hint. User messages use role color, semibold text and a subtle background. The composer has a complete border and a visible focus treatment. Narrow layouts wrap metadata instead of dropping fields.

The visible demo presents one coding workflow with four palettes, Signal, Amber, Ion and Prism. All terminal canvases and composer backgrounds are black. The selected visual treatment combines Instrument framing with Deep field grain and header particles. Changes preserve playback progress. URL hashes use `#palette/instrument-deepfield`. The `themes` registry owns descriptions and component swatches, and CSS tokens own semantic colors. Session labels are visually hidden and retained for assistive technology and hover descriptions. The composer submits with Enter and has no send icon. Its 8px rounded purple border stays visible without focus. Body text has no texture or filter. Browser grain does not prescribe native terminal rendering.

Source references inspected for the palette model are Codex `tui/styles.md`, `bottom_pane/status_line_style.rs`, `diff_render.rs`, and `markdown_render.rs`; Kimi `tui/theme/theme-schema.json`, `theme.ts`, and `components/messages/user-message.ts`. ArkCode uses distinct semantic tokens for roles, tools, paths, commands, headings, inline code, syntax, diff and footer values. These are custom palettes, not copies of Codex or Kimi themes.

Prism is the default palette. Tools, paths, commands, Markdown headings and code use neutral white or gray. Warm gray distinguishes user messages, and red/green retain diff and test meanings. Footer values keep separate, muted role colors. Explorer and edit success markers are gray; command success remains green. Grain opacity is 0.035, and text is not filtered. The other palettes remain available for comparison.

The composer has initial focus. Clicking terminal whitespace returns focus without scrolling or disrupting text selection. Ordinary keys and pasted text in the terminal route to the composer. Reserved shortcuts and approval choices retain their own handling. Browser controls outside the terminal retain normal browser keyboard behavior; playback and palette clicks return focus to the composer. Grapheme boundaries preserve emoji during routed deletion. Native TUI input routing and IME protocols still require implementation in the production terminal frontend.
