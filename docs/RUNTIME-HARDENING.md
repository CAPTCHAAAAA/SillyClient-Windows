# Runtime Hardening

These changes live in the isolated release-hardening worktree. On 2026-10-03,
the user approved the real frontend preview and authorized a local build and
installation trial. The reviewed frontend is now synchronized to Windows source,
built locally and synced with the Windows frontend lock. Version 2.0.1 is
unchanged. This preparation is not an installed release or installation
acceptance; packaging and the actual machine trial remain separate steps.

## Ownership And Cancellation

- `runtime/operations.ts` serializes lifecycle mutations. A new launch invalidates
  earlier work immediately; deletion waits for the old operation to finish.
- `provisionAndStart` and `migrateInstance` accept an optional `operationId`.
  Progress, log, ready and error events include the instance and operation IDs.
  A scoped `closeTavern` cannot stop a newer operation or hide its reader window.
  `getStatus` reports the actual ready server IDs, not pending installation IDs.
- `runtime/process-supervisor.ts` can stop only child processes tracked by this
  Electron process. There is no port-based kill and no command-line substring
  search. Task-tree shutdown and application quit are asynchronous and wait for
  confirmed closure. Failed shutdown is reported and can be retried.
- npm and terminal commands have output bounds, cancellation and timeouts.
  No retry begins while a timed-out process remains alive.
- `runtime/logs.ts` handles partial UTF-8 lines, bounds memory, writes
  asynchronously and rotates server logs at 4 MiB with one predecessor.

## Filesystem Boundaries

- Provisioning prepares a unique sibling directory and refuses to replace a
  nonempty incomplete installation. Rollback requires unchanged directory
  identity, a complete content fingerprint and no owned process still using it.
  Migration and fresh-install fingerprints cover all ordinary files, including
  data and dependencies. The 131,072-entry and 2 GiB bounds authorize automatic
  rollback only; exceeding them yields unknown ownership, not a migration or
  installation capacity error. Normal publication and startup continue, while
  a later rollback preserves the unknown target and reports it. Link,
  cancellation and unstable-file checks still fail closed even beyond these
  bounds. Published
  targets changed by users or the running server are preserved and reported;
  only unchanged owned targets may be removed.
- `runtime/dependencies.ts` keeps pending npm state in the host-owned
  `bootstrap/dependency-installs` directory. Failed or cancelled npm attempts
  retain that state even if they produced partial `node_modules`; a later
  launch repairs them before starting. Only successful, uncancelled installs
  clear the marker. Takeover never repairs source dependencies or writes a
  source-directory marker.
- Direct bundled Node invocation never writes `start-server.bat`. Existing
  `config.yaml` is preserved; supported runtime options are CLI overrides.
  Heartbeat intervals retain the frontend's numeric 0..2,147,483,647 contract
  in both CLI arguments and new config files. Launch argument generation is
  the single validator for runtime flags, heartbeat and ports. Ports must be
  numbers rather than coerced strings or booleans. Supplied runtime
  configurations must be mapping objects with only supported keys; flags are
  booleans and heartbeat values are finite integers within the stated range.
  At least one IP protocol must be enabled. New YAML uses upstream's
  `enableKeepAlive` key; existing YAML comments, security settings and custom
  roots remain byte-for-byte unchanged when applying CLI overrides.
  Takeover never reinstalls missing dependencies or applies presets to source.
  Custom TLS configuration is preserved, but local HTTPS takeover probing is
  not yet supported by the launcher and is not claimed as validated.
- `runtime/migration.ts` uses fresh targets, rejects overlaps/links, validates
  takeover roots and checksums copied files. ZIP and directory copies both
  exclude dependencies, Git metadata and (unless requested) secrets.
  Migration never auto-starts. Registration failure rolls back only its copy.
- A shared directory referenced by another registration is unregistered rather
  than physically deleted.

## Installation Paths

- `provisionAndStart`, `getInstanceInfo` and `uninstallInstance` accept optional
  `installPathMode: 'root' | 'exact'`. `root` always appends the normalized
  instance ID to the selected parent; `exact` always uses the selected full
  instance directory. Neither explicit mode depends on directory existence.
  Older callers omitting the mode retain the existing-directory inference.
- `pickDirectory({ purpose: 'installation' })` opens a directory-only native
  picker for an installation root and returns the full absolute selected path.
  The result also identifies `installPathMode: 'root'`; explicit `source`
  purpose and legacy calls retain the original source-picker result.
  The caller supplies `root` when browsing and `exact` when entering a complete
  directory manually. A successful info query returns the actual registered
  path, which the caller persists without the original root-selection mode.
  Legacy source pickers and cancellation retain their previous return shape.
- Supplied invalid paths, unknown modes, filesystem roots used as exact instance
  directories, and conflicting registered paths are rejected without selecting
  a default. Existing file targets and nonempty incomplete directories are
  checked before stopping a previously running instance.
- A registered custom directory remains authoritative even when missing.
  Scanning cannot replace it with a same-ID managed directory; info retains its
  path with `not_found`, launching refuses it, commands cannot run in a fallback
  directory, and removing its registration preserves any unrelated default
  directory. Malformed registered paths fail closed instead of disappearing.
- Copy migration targets remain exact paths, never selected installation roots.
  Instance maintenance continues to support only default managed directories;
  this path fix does not expand maintenance to custom or takeover directories.

## Cleanup

`runtime/cleanup.ts` issues single-use five-minute scan capabilities. Deletion
requires the original path and token, rechecks current eligibility and file
identity, and rejects roots, traversal, symlinks and junctions. Errors and actual
freed bytes are returned instead of unconditional success.

Only empty unregistered managed instance directories are eligible. Unrecognized
nonempty directories are preserved even without `package.json`. Covers are
preserved unless a complete absolute-path reference list is supplied; registered
instance cover names remain protected even with an empty list. Cover replacement
and lifecycle changes invalidate earlier scan capabilities. Active logs and
recent temporary files are excluded.

## Scan Cost

`InstanceRepository` reads one snapshot per scan, batches discoveries and does not
rewrite an unchanged registry. Replacement writes and flushes a unique temporary
file, then renames it without deleting the old file first. Corrupt registries are
not silently replaced with empty ones. A first scan never erases a live session.

On-demand directory sizing uses asynchronous filesystem APIs, a bounded 30-second
cache and no link traversal. Normal scans do not recursively calculate sizes.

## Optional Preinstallation

`runtime/preinstalled-extensions.ts` consumes the metadata-only revision-1 catalog
from `resources/preinstalled-extensions/catalog.json`. Only the four selected
allowlisted repository IDs are accepted. Downloads use HTTPS codeload URLs with
fixed commit IDs, exact archive sizes and SHA-256 verification. Third-party
archives, code and assets are never included in the launcher package.

Archive limits are 32 MiB compressed, 128 MiB expanded, 32 MiB per file and 8,192
entries. Extraction is asynchronous, refuses links and traversal, checks the
expected archive root, pinned extension version, nonempty declared compiled
assets, retained license file and actual SillyTavern minimum
version. There is no extension npm install, Git command or postinstall script.

`runtime/instance-config.ts` parses the data root with a short owned bundled-Node
process using the installed SillyTavern YAML dependency; the query does not load
extension modules. Empty documents are normalized to a mapping, while scalar
and array roots fail closed. Custom
roots are accepted only inside the selected instance. Unknown/external roots,
missing parsers and links fail closed before extension files are installed.
Extensions use the upstream per-user `dataRoot/default-user/extensions/<repo>`
layout. Existing extensions and disabled settings remain untouched.

Selections form one transaction. A marker, directory ownership and a bounded
SHA-256 content fingerprint for every file protect rollback, including same-size
edits with restored timestamps. Post-install user changes are preserved and
reported rather than deleted. Provisioning commits the extension transaction only after service
readiness. Copy migration prepares missing base-runtime dependencies when this
option is selected, installs extensions, then registers and commits. Takeover
rejects a nonempty extension selection without writing into its source.

Companion themes share that YAML query but require the default `dataRoot` before
any actual write. An already-applied theme is a true no-op and does not override
later custom roots. Resource and destination ancestors reject symlinks and
junctions, including data, settings and marker paths. Theme rollback restores
only files whose bytes still equal this transaction's output; changed files are
preserved and reported. Failed atomic replacement never predeletes the old file.

The regression suite additionally extracts all four audited pinned archives into
a synthetic temporary instance, verifies installation and rollback, and never
executes their JavaScript or styles. This establishes archive and filesystem
compatibility, not runtime feature compatibility inside SillyTavern.

## Verification

Run with the bundled Node.js runtime, not an arbitrary system Node:

```powershell
& <bundled-node.exe> --test tests/runtime-hardening.test.cjs
& <bundled-node.exe> node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Tests transpile the actual TypeScript into isolated modules. Process creation,
taskkill, HTTP probing and downloads are mocked; disk fixtures are synthetic
subdirectories of `Local/临时` and self-cleaned. This does not establish actual
Electron installation, upstream-extension compatibility or full-device
performance. No real instance data is opened, registered, launched or killed.

The behavioral cases include real frontend heartbeat defaults, actual YAML query
script execution, interrupted npm recovery, companion-theme write boundaries
and published-target rollback after ordinary user data changes.

At the approved Windows preparation checkpoint on 2026-10-03, frontend typecheck,
production build and host typecheck passed. The frontend source suite passed
47/47; the complete host suite passed 79/79 using bundled Node.js 22.16.0, with
no failures or skips. The CommonJS contract-test loader uses a TypeScript AST
transformer to evaluate only `import.meta.env.DEV` as false; it still loads the
actual frontend configuration and never executes the browser preview shim.
Production assets contain no synthetic preview entry points. Evidence is under
`Local/evidence/release-hardening-20261003/output/windows-approved-*`.
