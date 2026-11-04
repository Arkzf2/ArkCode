# Contributing to ArkCode

Use Node.js 22.19 or newer in the repository root:

```powershell
	npm install
	npm run dev
```

Installation applies the host patch to the pinned Pi SDK versions. Do not skip the install script. If the patch check fails, check the dependency versions and file sources first. Do not change the check values just to suppress the error. The four direct Pi dependencies are pinned to `1.5.0`.

## Verifying changes

```powershell
	npm run check
	npm test
	npm run build
	node dist/cli.js --help
	npm run docs:check
	git diff --check
```

Choose the relevant behavior tests for the scope of your change. Runtime tests use the real Pi SDK, a local model protocol service, files, and processes. They do not require paid model credentials. OAuth browser callbacks, cross-platform process cleanup, and terminal input behavior need their own environment verification.

## Maintaining product documentation

The README covers the product introduction and first-use entry. Root `README.md` is the default English entry; `README-CN.md` is the Chinese entry. The [documentation language index](docs/README.md) leads to `docs/en/` and `docs/zh-CN/`. Both trees use identical filenames and cover quickstart, task guides, interface references, concepts, and troubleshooting. Keep one primary location for each rule in each language; other pages link to it.

Every localized page has a language switch on the third line. It links to the same page in the other language. Other product links stay in the current language. Pages below a language home also link back to that home. To add, rename, or remove a page, change both language trees and their navigation in the same patch. Use an existing page as the navigation template.

English is the default entry language, not a separate behavior specification. Runtime definitions and versioned contracts define product behavior. Either language may be edited first. Update both versions in the same patch when behavior, options, limits, or failure conditions change. Never translate command names, configuration keys, JSON fields, or exact runtime prompt blocks.

If a prose-only translation must follow later, put a visible `Translation status: pending` notice below the navigation of the page that is behind. Link the notice to its up-to-date counterpart and state which section is pending. Remove the notice when synchronized. Interface and permission changes must be synchronized before release. Structural checks do not verify translation accuracy.

`CONTRIBUTING.md` is a shared English-only document, and `docs/README.md` is a bilingual language chooser. These are the only unpaired Markdown pages. Language-independent schemas and tool inputs live once in `docs/shared/`; both languages link to them. Localized generated tables come from one generator. The compaction prompt reference keeps exact runtime text in both languages, and checks validate both copies.

Product docs describe ArkCode's current behavior. SDK differences, migration plans, design prototypes, and acceptance trails do not enter product navigation. `maintainers/` stores local maintenance material; it is ignored by Git and is not distributed in source or npm packages. Shared development requirements must stay in this page, scripts, or versioned product references.

CLI help, the command directory, configuration defaults, and tool inputs come from the actual definitions. After changing the related code, run:

```powershell
	npm run docs:generate
	npm run docs:check
```

Do not edit `docs/en/reference/generated/`, `docs/zh-CN/reference/generated/`, or `docs/shared/` by hand. `npm run schemas:shell` regenerates `docs/shared/schemas/` alone. Generators do not start models or MCP servers.

`docs:check` verifies language pairs, page switches, same-language navigation, reachability from each language home, exact prompt contracts, references, heading anchors, interface coverage, configuration examples, stale generated files, and document links in the npm package. Product pages must not depend on local paths, ignored maintainer directories, or research files. When behavior, failure conditions, or limits change, update the related guide and reference at the same time.

## Building and publishing

`npm run build` cleans and rebuilds `dist/`. `npm pack` builds before packing; the installed package contains product docs and the SDK install patch and excludes maintainer archives. To inspect the package manifest, use:

```powershell
	npm pack --dry-run --ignore-scripts --json
```

That command checks file distribution only. It does not replace a formal build and a separate install acceptance check.
