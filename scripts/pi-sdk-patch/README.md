# Pi SDK 1.2.0 host hooks

ArkCode uses Pi's public `createMcpExtension()` and tool factories. Pi 1.2.0 does not expose all hooks needed by an embedding host, so `../patch-pi-sdk.mjs` adds these hooks to this package's installed SDK. It does not change the separate Pi checkout or an independently installed Pi CLI.

The patch adds:

- A public MCP controller for snapshots, readiness, targeted configuration reload, cancellation, shutdown, and OAuth sign-in/out.
- Snapshot sign-in/sign-out availability comes from the SDK connection challenge and stored OAuth tokens, so local or unauthenticated servers do not show account actions.
- Host credential and log directories, tool filtering, connection guards, startup deadlines, and diagnostic redaction before truncation.
- Authorization of the actual live client immediately before dispatch, with connection and tool metadata checked again after approval. An SDK session-expiry retry must authorize its new client.
- Sequential MCP definitions and a resource-tool switch. ArkCode disables resources until it provides a resource authorization policy.
- `GrepToolOptions.excludeGlobs`, applied as case-insensitive exclusions after the model's glob, and `maxFileBytes`, enforced by ripgrep before reading matches. The host must still reject protected explicit search paths.

The extension continues to own MCP transport setup, discovery, reconnection, OAuth, names, output schemas, and result conversion. The patch does not add a second MCP client manager.

The installer checks the package version and normalized SHA-256 digests in `manifest.json`. It accepts an original file, the exact patched file, or an explicitly listed earlier patch digest, and refuses unexpected contents. Earlier patches are upgraded using their verified upstream backups. Original bytes are preserved under the dependency's `.arkcode-sdk-originals/` directory. All output digests are checked before writes. A rerun completes partial application and is otherwise a no-op.

When upgrading Pi, first check whether its public API now provides these hooks. Remove superseded patches. Review the remaining transformations against the new published package and update the version and digests deliberately. Run `test/sdk-patch.test.ts` and the MCP/runtime permission regressions. Do not update checksums merely to suppress an installation failure.

`agentDir` here controls MCP credentials and logs. Pi's other caches and downloaded search binaries retain the SDK's upstream locations. Authorization and per-server state stay in ArkCode's directory.
