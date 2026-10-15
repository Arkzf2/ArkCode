# ArkCode product and architecture design

## Investigation
- [x] Route through the how skill. Existing repository study is the grounding input; verify SDK contracts in this pass.
- [x] throughput checkpoint: n/a, read-only investigation
- [x] Produce a recommendation with ownership, execution flow, product design and tradeoffs.
- [x] Apply the unslop skill to the reply.

## Architect
- [x] Ground
- [x] Sketch: compare two structurally distinct proposals under the accepted SDK choice.
- [x] Agree: default autonomous synthesis, no user checkpoint requested.
- [x] Implement: single-file HTML design artifact, not application implementation.
- [x] Scrap: revise the design if evidence exposes ownership conflicts.

## Swarm
- [x] Frame: a source-grounded Chinese design for ArkCode v1, in standalone HTML with inline SVG, flows and an interactive product storyboard.
- [x] Fan out: two competing architecture/product proposals plus one SDK contract review. Separate files.
- [x] Aggregate: choose one architecture and log accepted/rejected ideas.
- [x] Report: browser-verified desktop and mobile artifact.

## Scope
- Accepted base: pi-coding-agent SDK.
- First product: local desktop coding workspace, TypeScript host, custom UI. Product form is a design assumption, not an existing app.
- v1: one active workspace and one active coding run in the application, durable Pi conversation history, explicit tool approval, stop, changes review and validation evidence.
- Defer Goal, autonomous background work, multi-agents, learned cross-session memory, plugin marketplace, cloud execution and bespoke compaction.
- Evidence: original repositories under E:/Github Programs; previous report under research/architecture/harness-report. Do not modify investigated repos.

## Visual plan
- Palette: canvas #f5f7fb, ink #17243a, cobalt #3159d9, teal #11796e, lilac #eae7fb, border #dbe2ef.
- Type: Segoe UI Variable and Microsoft YaHei UI for reading; Georgia restrained Latin display; Consolas for interface contracts.
- Layout A: long dashboard of equal cards. Rejected because it obscures the end-to-end coding journey.
- Layout B: editorial guide with an interactive workbench at its center, followed by diagrams and precise contracts. Selected.
- Signature: one concrete coding task replayed across normal, approval, stopped and recovered states; each state explains the corresponding responsibility.
- Output data: sections, source references, product scenarios, architecture ownership map, lifecycle transitions and release gates.
- Model routing: configured skill model defaults are unavailable; use inherited available models for design work. Cross-family audit will be attempted separately; a failed attempt is not a review.

## Arena
- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [x] Verify

Rubric: SDK ownership correctness; first-release implementation scope; stop/recovery honesty; dirty-workspace safety and attribution; product clarity. Compare host-integrated A against workspace-worker B. These are architectural alternatives, not benchmarked implementations.

## Delivery outcome
- Standalone HTML built with inline CSS, scripts and three SVG diagrams.
- 25 fixed-commit source references checked against clean local repositories.
- Desktop 1440x1000 and mobile 390x844 inspected; scenarios, source search and module selector exercised.
- Same-family independent review completed; two findings corrected. Cross-family Kimi attempt failed authentication.
- Application runtime and fault-injection tests are future implementation gates, not claimed results.
