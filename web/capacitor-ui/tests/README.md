# Release Hardening Checks

These tests use the existing TypeScript dependency and `node:test`; no additional
production dependency is required.

- Run `node --test tests/*.test.cjs` for bounded log storage, stale-operation
  rejection, late listener cleanup, tokenized garbage plans, shared snap locks,
  idempotent material annotation, backup parsing, controlled external links,
  and finite pagination geometry, coverage and interruption.
- With the real Vite preview already running, set `PLAYWRIGHT_MODULE` to an
  installed Playwright module and run
  `node --test tests/native-preview.browser.cjs`.
- Run `node --test tests/scroll-layout.browser.cjs` for classic-scrollbar wizard
  and pull-to-refresh width stability.
- Run `node --test tests/card-pressure.browser.cjs` for position-aware pressure,
  preserved hover, cancellation, and independently owned scroll locks.
- Run `node --test tests/external-links.browser.cjs` for actual project anchors,
  complete URL text/href/title, single-line ellipsis, keyboard activation,
  unchanged wizard/native state, and browser-mode-independent project/update
  navigation. Catalog license metadata and downloaded notices remain retained.
- Run `node --test tests/panel-dissolve.browser.cjs` for first/later switch
  consistency, single-layer migration transitions, interruption, unscaled
  content height, immediate focus/hit isolation and reduced motion.
- Run `node --test tests/pagination.browser.cjs` for centered fixed geometry,
  dot coverage during jumps/reversals, shared theme color, keyboard navigation,
  live reduced-motion changes, visibility and zero idle frame work.
- Run `node --test tests/native-preview.browser.cjs tests/card-pressure.browser.cjs`
  for the preserved preview/pressure suites after a pagination change.
- Run `node --test --test-concurrency=1 tests/*.browser.cjs` for the complete
  browser set after all independently owned UI changes have settled.
- `PREVIEW_URL` defaults to `http://127.0.0.1:8767/`.
  `CHROME_EXECUTABLE` can select an installed Chrome binary.

The `?nativePreview=1` development-only route uses the actual React application
with a synthetic Native implementation. It never calls a real native host,
touches user instances, or downloads data. The browser checks block external
network requests and do not capture screenshots or perform visual review.
The panel suite records technical animation samples in
`Local/evidence/release-hardening-20261003/output/playwright`; set
`PANEL_DISSOLVE_EVIDENCE` to another approved local evidence directory when
needed. These computed samples are not native/device acceptance.

`window.__SILLYCLIENT_TEST__` provides `calls`, `pending()`, `complete(id, ready)`,
`emit(event, data)`, `listeners()`, and `configure(...)`. Configuration supports
manual provisioning, delayed listener registration, refused garbage deletion,
failed migration, and rejected commands. Production builds do not load this shim.
The optional `window.__SILLYCLIENT_PREVIEW_FIXTURE__.contentOpenMode` field sets
the synthetic initial Tavern mode. Native external calls only record targets;
they never launch an OS browser. The external browser suite also intercepts
`window.open`, denies real popup attempts, and aborts non-localhost requests.

The real application checks cover idle mutation stability, stop/late-ready
races, a 10,000-line burst, snap ownership, default-off preinstallation, inactive
remote/takeover controls, provisioning and migration retries with captured
selections, project anchors with license metadata retention, post-stop command output, bounded
command errors, and retained garbage refusal details.
Creation also exposes an explicit cancellation control; its regression confirms
late readiness cannot register a cancelled instance.

These commands exercise the existing real React preview and synthetic bridges.
Do not synchronize platform UI, run production frontend checks/builds, package,
install, or publish before explicit preview approval. Native unit compilation
and host-only Windows checks are separate technical verification.

## Verified Preview Checkpoint

At the 2026-10-03 preview checkpoint, Root's complete source set passed 47/47
and the complete browser set passed 59/59, with no failures or skips.
Logs are `Local/evidence/release-hardening-20261003/output/frontend-source-visual-final.log`
and `frontend-browser-visual-final.log` in the same directory.
The focused panel suite passed 10/10; pagination source/browser passed 9/9
and 7/7, with preserved native-preview/pressure checks 30/30. These overlapping
counts are not additive. Root approved plan 005's final independent motion/code
review; all five plans have completed isolated implementation and review.
User preview approval is still required; this checkpoint is not native,
installed-client or release acceptance.
