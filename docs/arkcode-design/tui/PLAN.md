# ArkCode TUI product specification

## Investigation
- [x] Route through the how skill. Parallel explorers cover Codex and Kimi TUI source and primary documentation.
- [x] throughput checkpoint: n/a, read-only investigation
- [x] Produce the recommendation with product surfaces, complete interaction contracts and tradeoffs.
- [x] Apply the unslop skill to the report prose. Final response uses the same style.

## Task units
- [x] Ground the new TUI entry in the accepted Pi SDK architecture.
- [x] Read official Codex and Kimi documentation and source snapshots.
- [x] Define startup, configuration, input, execution, approvals, changes, history and error flows.
- [x] Build a standalone HTML report with an interactive TUI storyboard.
- [x] Review interaction consistency and SDK boundaries independently. Cross-family attempt failed authentication; same-family independent review completed.
- [x] Verify desktop/mobile page layout, actual prototype behavior and offline dependencies. Ctrl shortcuts remain unverified through browser automation; file URL blocked, static self-containment checked.
- [x] Link the new specification from the earlier architecture report and record superseded desktop assumptions.

## Scope
Design artifact only. pi-coding-agent SDK remains the base. The TUI supervisor replaces Electron desktop concerns. One directory per invocation, one writer per canonical workspace across processes; no Goal, multi-agent, background execution or extension marketplace in v1. Windows first; terminal compatibility requirements include macOS/Linux without claiming these are already tested.

## Visual plan
Quiet white report canvas (#f7f8fa), ink (#20262e), teal (#087d72), cobalt (#345acb), amber (#956005), red (#b13b43). Terminal uses neutral charcoal (#1e2228), readable gray (#dce1e6), teal success and amber approval. Segoe UI / Microsoft YaHei for prose; Cascadia Code / Consolas for terminal and commands. Compact heading, a real terminal storyboard in the first viewport, then unframed bands of specifications. Compare full-screen single-column against inline scrollback; select regular main-screen scrollback with tail input and temporary detail panels. Defer full-screen until user evidence justifies it. No permanent sidebar or split-pane dashboard.

## Verification limits
HTML prototype and source verification are achievable here. Native TUI input decoding, IME, Job Object cleanup, terminal capability detection and real model execution are implementation acceptance gates.
