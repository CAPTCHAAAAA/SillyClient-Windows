# Windows Data Migration Test Build

The filesystem/CLI engine produces a **verified data copy** without registering
an instance. The Windows test build also exposes a native File menu importer,
described below, with separate copy-migration and in-place-takeover modes.
Neither entry changes `TarvenEnv` or the React frontend.

## Scope

- Recognize an installation by `package.json`, a regular `server.js`, and a
  profile-shaped data tree. The version filter accepts SillyTavern 1.x with a
  minor version of at least 12; that filter is not a compatibility certification.
- Read `dataRoot` from `config.yaml`, or use an explicit `--data-root` override.
  YAML aliases, duplicate keys and oversized metadata are rejected.
- Copy to a **new, nonexistent directory** whose parent already exists.
  Source and destination cannot overlap.
- Retain profile directories, `_storage`, chats, characters, worlds, settings,
  other data files and empty directories, subject to the exclusions below.
- Check free space, copy in bounded buffers, verify SHA-256, rescan the source,
  and verify both content hashes and the destination inventory before success.

Only regular local directories/files are accepted. Symlinks, junctions, UNC
paths, unsafe Windows filenames and case collisions are rejected. Scanning is
limited to 100,000 entries and 64 directory levels.

## CLI Exclusions

- Installation source, `config.yaml`, old Node.js binaries and dependencies.
- `.git` and `node_modules` directories inside the data tree.
- Root/profile `extensions` directories. Global third-party extensions outside
  the data tree also remain outside this operation.
- `secrets.json` files, unless `--include-secrets` is explicitly supplied.

Excluding `secrets.json` is **not anonymization**. Settings, conversations and
account records may still contain private data. Reports contain paths, profile
names and hashes, but not file contents. Protect the copy and report accordingly.
On Windows, destination access permissions inherit from the chosen parent;
this tool does not recreate source ACLs or encrypt the destination.

## Commands

Run from the Windows repository/worktree root. Prepare its fixed Node.js runtime
as described in `runtime/README.md`, or explicitly point `$node` at an already
prepared **bundled** Node.js 22.16.0. Do not use a system-PATH fallback.

```powershell
$node = (Resolve-Path '.\runtime\node\node.exe').Path
& $node --experimental-strip-types .\scripts\data-migration.mjs --help
& $node --experimental-strip-types .\scripts\data-migration.mjs inspect 'D:\OldSillyTavern'
```

For the current isolated workspace, the prepared runtime can explicitly be
selected with:

```powershell
$node = 'D:\BACKUP\Project\SillyClient\SillyClient_Windows\runtime\node\node.exe'
```

`inspect` only reads the source and prints a summary. If data lives outside the
installation, review that location before authorizing `--allow-external-data`.
Relative `--data-root` values resolve against the installation, not the CLI's
working directory. Launcher-supplied overrides cannot be automatically inferred.

Stop the old SillyTavern and all other writers before copying. The flag below
records the caller's confirmation; it does not inspect or terminate processes.
The example destination's parent must already exist:

```powershell
& $node --experimental-strip-types .\scripts\data-migration.mjs copy `
  'D:\OldSillyTavern' 'D:\MigrationTrials\trial-01' --source-stopped
```

Optional flags:

| Flag | Purpose |
| --- | --- |
| `--data-root <directory>` | Override the configured data location |
| `--allow-external-data` | Authorize reading data outside the installation |
| `--include-secrets` | Explicitly include `secrets.json` |

Successful output contains `status: "verified-data-copy"` and
`registeredAsInstance: false`. The new directory contains `data/` and
`migration-report.json`. No source code is executed, no packages are installed,
no instance is registered, and no source content is modified or deleted.
Normal filesystem reads may update access timestamps.

## Failure Handling

Ctrl+C requests cancellation. Ordinary errors/cancellation remove only the exact
new directory bearing this operation's ownership marker. An existing destination
is never merged with or overwritten.

If ownership changes or cleanup fails, the command returns `CLEANUP_REQUIRED`
and leaves the incomplete directory for manual review. It never claims that
rollback succeeded when it did not. Do not store unrelated files in the target
while the tool is running.

Forced termination, power loss or OS failure can leave
`.sillyclient-migration-incomplete`. Any directory still bearing this marker is
incomplete, even if it also contains a report. There is no automatic recovery or
resume service. Choose a new destination for a retry after reviewing the old one.

This is not a filesystem snapshot, a protection against hostile concurrent
filesystem mutations, or a durable transaction across power loss. Checksums do
not prove valid chat/character schemas, compatible extensions or successful
SillyTavern startup.

## Verification

Tests create synthetic installations and never use real user data or execute
SillyTavern. Set the test root to an approved temporary directory; each test
creates and removes only its own `migration-case-*` child.

```powershell
$env:SILLYCLIENT_MIGRATION_TEST_ROOT = 'D:\path\to\temporary-migration-tests'
& $node --experimental-strip-types --test .\tests\data-migration.test.mjs
```

The 34 tests cover multiple profiles, byte/hash fidelity, source preservation,
secret opt-in, configuration validation, external-data consent, path overlap,
junctions, destination protection, cancellation, simulated disk/cleanup errors,
concurrent changes, short writes, large files, Unicode and CLI behavior.
The module also passes a scoped strict TypeScript check with CommonJS output
settings; no frontend build or installer build is part of this validation.

Node 22.16.0 emits experimental type-stripping/module-detection warnings for this
development CLI. Do not change the application's CommonJS package mode just to
silence them.

## Enhancements (migration.8)

1. **ZIP Archive Direct Import**:
   - Supports selecting `.zip` backup archives or bundled distributions.
   - Built-in Zip-Slip path traversal defense and uncompressed size boundary guard (20GB).
   - Adaptive tavern root directory detection (handles flat zip structures and nested folder layouts).
   - Real-time decompression progress reporting and reliable temporary staging cleanup.
2. **Automatic Local Tavern Discovery**:
   - Automatic scan of common paths (`USERPROFILE\Desktop`, `Downloads`, `Documents`, and drive roots `C:\`, `D:\`, etc.).
   - Fast, shallow detection checking `package.json` version and `server.js` without full-drive indexing.
   - Integrated into the debug window with a one-click scan button and candidate dropdown selector.
3. **Plugin & Extension Compatibility Preflight**:
   - Deep inspection of server plugins (`plugins/`) and client extensions (`public/scripts/extensions/third-party/`).
   - Identifies native C/C++ module dependencies (e.g. `better-sqlite3`, `canvas`, `sharp`, `node-pty`, `binding.gyp`) that carry Node 22 compatibility risks.
   - Verifies entry existence and flags deprecated legacy libraries.
   - Automatically included in confirmation dialogs and migration plan warnings.

## Enhancements (migration.10)

1. **Chat Label Compact Timestamp Stripping**:
   - Extended history chat and welcome screen label parsing to support compact timestamp patterns (`YYYYMMDD-HHmmss` and `YYYYMMDD_HHmmss`).
   - Cleanly strips timestamps without dashes between year, month, and day while preserving character names and branch prefixes.
   - Covers history dropdowns, welcome screen cards, and lorebook links.
2. **Startup & Streaming Performance Optimizations**:
   - **Non-blocking Instance Scan**: Decoupled synchronous recursive directory sizing (`fs.statSync` across tens of thousands of files) from initial instance discovery; replaced with memory caching and asynchronous lazy calculation, dropping instance scan latency from seconds to <5ms.
   - **DOM Mutation Stream Pruning**: Removed `characterData` watching from the chat title observer and added instant short-circuit filters (`#chat, .mes, .mes_text, #send_form`) to eliminate UI thread hangs during streaming token output.
   - **Chromium V8 Code Cache**: Configured immutable HTTP caching headers for `app://` and `capacitor-file://` protocols, allowing persistent `.code-cache` compilation and accelerating cold start times.
   - **Fast Health Probe & Direct Spawning**: Tuned instance readiness poll interval to 200ms and spawned `node.exe` directly, shaving 1-1.5s off instance boot time.

## Remaining Work

The user has tested an actual import successfully. Agent-run checks use synthetic
data; real conversation content and runtime compatibility have not been audited.
Still unimplemented:

- Legacy layout conversion and downloading a fresh runtime instead of copying.
- React import UI, conflict/merge workflows, Android import and interruption recovery.

Selecting a single profile (such as `data/default-user`) is not supported;
select its containing data directory instead.


## Local Test Installer

The `electron-builder.migration-test.cjs` configuration packages the existing
host/frontend with this CLI as `1.9.1-migration.7`. It uses the normal SillyClient
application ID, executable, shortcut and data/profile locations, so installation
replaces the local app rather than creating an isolated test app. Use only with
explicit approval to overwrite that installation; it does not migrate user data
automatically.

Use **File > Import old SillyTavern** (Chinese UI: 文件 > 导入旧酒馆), then
choose **复制迁移** or **原地接管（不推荐）**.
The native importer accepts an installation or its data directory. A detached
data directory additionally requires the user to select its original runtime;
no runtime version is inferred or downloaded automatically.
The native dialogs show the detected version, source/data paths, file count and
managed destination parent. The user must confirm that the old server is stopped.
API secrets are opt-in; external/custom data directories require consent.

`src/windows-import.ts` connects this flow to `runtime/import-instance.ts`.
It copies data and the same installation's runtime into a new staging directory,
checks hashes, then moves the complete result into a unique managed directory and
registers it. The list refreshes after success. Runtime files are limited to
`src`, `public`, `default`, `plugins`, root JavaScript modules and package/license
files. Native copy migration includes per-user extensions under the data tree,
global extensions under `public/scripts/extensions/third-party`, server plugins,
presets and their settings. The data-only CLI retains its conservative exclusions.
Old `node_modules` and `.git` files/directories are excluded. `secrets.json`
requires opt-in in both data and plugin/runtime trees; other plugin configuration
can still contain credentials, so this is not anonymization.

The native copy preserves custom configuration keys and the source
`enableServerPlugins` toggle. `runtime/import-config.ts` adjusts only the copied
configuration for the managed local environment: local data directory, IPv4
localhost HTTP, user-account login, no automatic browser launch or plugin updates.
Original listening/HTTPS/HTTP Basic Auth/reverse-proxy authentication is not
carried over. This adaptation is explicitly disclosed before confirmation.
Subsequent startup retains plugin-specific configuration instead of replacing it
with a small default config. Only trusted source installations should be selected.

The new instance is local-only and retains multi-user login when needed.
It is not started during import; its first normal launch installs dependencies
using the bundled Node.js. Enabled server plugins with their own `package.json`
receive a separate dependency install before startup. Preparation is marked ready
only after success, remains retryable on failure, and is not repeated on subsequent
launches. Import itself never executes plugin code or npm; explicit startup can
execute dependency lifecycle scripts and enabled plugins.
Successful import does not certify real-world startup
or extension compatibility. Cancel via File > Cancel import; closing the window
during an operation requests cancellation. Failed registration retains a marked
copy which is excluded from scanning and startup.

Plugin-specific absolute paths, external services, native/system dependencies and
build requirements may still need manual adjustment. Git updater metadata is not
copied; online plugin updates may require reinstalling that plugin. Existing
copies made with migration.5 or earlier are not silently modified or backfilled.
Reimport into a new directory to use this expanded copy scope.

**File > Directory import debug** (文件 > 目录导入调试, Ctrl+Shift+M)
opens a small host-owned window calling the same importer. Two radio choices
select the actual backend mode. Both accept the original installation/data folder;
only copy migration asks for a destination parent.
The actual default destination path is filled in at startup, not hidden behind
an empty input; clearing it requires selecting another folder. If a data-only
selection has no adjacent runtime, a native dialog asks for the original program
folder only when needed. Start/cancel operate on the real importer.
The window, confirmation and completion dialogs explicitly describe copy-mode
semantics: originals remain on disk, future changes do not sync, and this partial
copy is not a complete backup. In-place takeover is not recommended because
configuration, dependency and concurrent-write conflicts cannot be ruled out;
it remains selectable and is implemented as described below.

The importer never offers source deletion or an automatic move-and-delete mode.
Completion lists both retained source paths and the new copy, and reminds the
user to verify all required data or make a recoverable full backup before
manually removing an unneeded old installation to avoid duplicate disk use and
accidentally continuing with stale data. Backup, verification and manual cleanup
remain user-controlled; successful file verification does not certify complete
migration or successful startup.
Staging is allocated inside the chosen destination parent, allowing cross-volume
source/target paths without a cross-volume rename. Existing directories are never
merged. IPC is limited to this isolated, sandboxed local window.
`--import-debug` opens it at launch. No React frontend change is involved.

## In-Place Takeover

`runtime/takeover-instance.ts` registers the original installation and data root
without copying, moving, installing dependencies or starting the server.
Existing plugins, presets and secrets stay in their original locations.
The registry persists `managementMode: "in-place"` and `dataRoot`; scanning and
usage updates retain them. Duplicate/overlapping instance registrations are
rejected, including existing junction aliases.

Starting the attached instance executes its original `server.js` with bundled
Node.js and `--configPath` pointing to an app-owned configuration under
`%LOCALAPPDATA%/SillyClient/tarven/in-place/<id>/config.yaml`. Original configuration,
batch scripts and dependencies are not rewritten by the launcher. The separate
configuration uses IPv4 localhost HTTP, disables browser launch and extension
auto-update, and retains user-account login and server-plugin settings.
The original startup method can still use its original configuration.
Both methods use the same data, not independent synchronized copies.

Stop the original server and all other data writers before attachment or launch.
An occupied configured/requested port fails without killing another process or
automatically changing ports. This check cannot detect every writer using the same
data on a different port. Never run the original launcher concurrently.
Missing dependencies, unrecognized `configPath` support, HTTP Basic Auth or
reverse-proxy SSO produce explicit errors; authentication is not silently removed.
Existing dependency/native-module and bundled-Node compatibility is not guaranteed.
Only attach trusted programs: the server and plugins can change the original
data themselves. This is not a read-only runtime or a promise of no conflicts.

Removing an attached instance asks for **仅解除接管**, stops only a process
started by this app, and removes the registration, freeing zero source bytes.
It never deletes the original installation or data. Destructive managed-instance
operations guard attached paths and aliases; garbage deletion accepts only
recognized cleanup candidates. The original directory remains the live directory,
so copy-mode "old-folder cleanup" advice is hidden for this mode.

`tests/takeover-instance.test.mjs` uses isolated synthetic files to test source
preservation, separate configuration, port conflicts, cancellation, aliases and
registry retention. The packaged Electron smoke additionally starts an authored
lightweight fixture, verifies original-data read/write, stops it and detaches it.
These checks do not establish compatibility of a real user's SillyTavern/plugins.
No screenshots or visual/aesthetic review are part of this validation.

For copied or in-place local instances opened inside SillyClient, a host display adapter
compacts recognized `Branch #N` prefixes/suffix chains and legacy timestamps.
Original DOM text, filenames and chat references remain unchanged, so upstream
rename/export still read the original identifier. Hover shows the original name.
This adapter does not apply to the external system browser or remote instances.
As of migration.7, activation resolves the running, app-owned instance and checks
the page origin. It accepts the scanned card's `scan-` display ID and reopening
without an ID, instead of mistakenly looking up a display ID in the registry.
The check runs again on reload; unrelated origins, remote cards, ordinary
nonimported instances and stopped runtimes do not receive the adapter.
Existing imports benefit after updating and reopening; no reimport is required
for this display fix.

Set `SILLYCLIENT_TEST_ELECTRON_DIST` to the prepared Electron 33.4.11 directory
and `SILLYCLIENT_TEST_NODE_DIR` to the bundled Node.js 22.16.0 directory when
packaging. Reuse only the frontend verified against `frontend.lock.json`.
The installed `Run-Migration.cmd` runs the CLI using the bundled runtime;
`Run-Migration.cmd --help` is a read-only installation check.
