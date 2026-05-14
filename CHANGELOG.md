# Changelog

All notable changes to `electron-driver` will be documented here. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-05-12

Minor release. Drops end-of-life Node 20 support, removes a synchronous
file read that blocked the event loop, and upgrades to Renovate's
`config:best-practices` preset.

### Changed

- **Engine floor raised from `>=20` to `>=22`** — Node.js 20 (Iron) reached
  end-of-life on **March 24, 2026** and no longer receives security patches.
  Node 22 (Jod) and Node 24 (Krypton) are both Active LTS and are the
  correct targets for production packages. Callers still running Node 20 must
  upgrade before installing v0.7.0.

### Fixed

- **Blocking `readFileSync` in `drop_file` handler** — The file being dragged
  was read from disk with the synchronous `readFileSync` API inside an async
  tool handler, needlessly blocking the Node.js event loop (especially
  problematic for large files such as images or videos). The call has been
  replaced with `await readFile()` from `node:fs/promises`.
- **Inaccurate Playwright version in `accessibility_snapshot` description** —
  The tool description cited "Playwright 1.57+ API" for `page.ariaSnapshot()`,
  but the method was introduced in **Playwright 1.59**. The `boxes` option was
  added in **1.60**. The description now reads "1.59+; `boxes` option requires
  1.60+", giving users accurate minimum-version guidance.
- **Future release date in `server.json` and `CHANGELOG`** — v0.6.1 had
  `release_date: "2026-05-14"` set to a date two days in the future. Corrected
  to the actual release date `"2026-05-12"`.

### Maintenance

- **Renovate upgraded to `config:best-practices`** — Replaces the previous
  `config:recommended` extend. The best-practices preset adds
  `abandonments:recommended` (alerts when a dependency is abandoned),
  `security:minimumReleaseAgeNpm` (3-day stability window for all npm updates —
  supersedes our explicit packageRule), `:configMigration` (auto-fixes
  deprecated Renovate config keys), and `:maintainLockFilesWeekly` (weekly
  lock-file refresh). The now-redundant explicit `minimumReleaseAge: "3 days"`
  packageRule has been removed.

## [0.6.1] — 2026-05-12

Patch release fixing a version string regression introduced in v0.6.0.

### Fixed

- **MCP server version mismatch** — The `Server` constructor in `index.mjs` was
  not bumped during the v0.6.0 release, causing the MCP server to advertise
  `version: '0.5.0'` to clients even though the package was `0.6.0`. The
  constructor now correctly reports `'0.6.1'`.
- **README status line** — The project status badge still read `v0.5.0` after
  the v0.6.0 release. Updated to `v0.6.1`.
- **`package-lock.json` stale version** — Root version was `0.4.0`; aligned
  with the current release.

## [0.6.0] — 2026-05-13

Infrastructure and packaging fix release.

### Fixed

- **`server.json` missing from npm package** — `server.json` was omitted from
  the `files` array in `package.json`, so it was never included in the published
  npm tarball. MCP registries and tooling that fetch the server manifest after
  `npx electron-driver` would receive a 404. The file is now correctly published.

### Added

- **Renovate config** (`renovate.json`) — automated dependency updates via
  Renovate (not Dependabot). Config extends `config:recommended` and adds:
  - 3-day minimum release age for npm packages (prevents yanked-package
    incidents)
  - Auto-merge for patch and minor updates after the stability window passes
  - Dependency Dashboard approval required for major version bumps
  - OSV vulnerability alerts enabled

## [0.5.0] — 2026-05-12

Feature release: four new tools leveraging Playwright v1.56–v1.59 native APIs,
plus element-scoped screenshots. Tool count: 39 → 43.

### Added

- **`page_errors`** — return uncaught JavaScript exceptions from the renderer
  page using Playwright's native `page.pageErrors()` API (v1.56+). Returns up to
  200 entries with `message`, `name`, and `stack`. Pass `clear: true` to drain
  after reading. Previously, uncaught exceptions were only visible in the
  `console_logs` buffer via the `pageerror` event — this tool provides direct,
  first-class access.

- **`network_requests`** — return recent network requests made by the renderer
  using Playwright's native `page.requests()` API (v1.56+). Returns up to 200
  entries with `method`, `url`, `resourceType`, and HTTP `status` code. Supports
  optional `urlFilter` (URL substring) and `resourceType` filters. Closes the
  documented "No built-in network-request capture yet — planned for v0.4"
  limitation in the README.

- **`start_screencast`** — start recording the current window as a WebM video
  using Playwright's `page.screencast` API (v1.59+). Designed for the agentic
  video receipt pattern: agents can record a walkthrough as proof of work. Saves
  to the session screenshots directory. Accepts an optional `name` for the output
  file.

- **`stop_screencast`** — stop the active screencast recording and flush the WebM
  file to disk. Returns the path to the saved file.

- **`screenshot` gains `selector` param** — pass a Playwright selector to crop
  the screenshot to the first matching element using `locator.screenshot()`.
  When `selector` is omitted the behaviour is identical to before. Uses the full
  Playwright selector engine, not just CSS.

## [0.4.1] — 2026-05-12

Quality-of-life release: full MCP `ToolAnnotations` support, Playwright-selector
upgrades for `elements_list` and `drag`, and several correctness fixes.

### Added

- **MCP `ToolAnnotations`** (spec 2025-03-26). All 39 tools now return
  explicit `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
  `openWorldHint` values in the `ListTools` response. Agent hosts that consume
  these hints (e.g. to show confirmation prompts before destructive actions)
  will now receive accurate information instead of relying on the dangerously
  permissive spec defaults (`destructiveHint: true`, `openWorldHint: true`).

### Fixed

- **`elements_list` used CSS-only `document.querySelectorAll`.** The handler
  now uses `win.locator(selector).all()` so the full Playwright selector
  engine is available: `text=`, `role=`, `:has-text()`, etc. Pass any
  Playwright selector, not just CSS.

- **`drag` `detectSelector` used CSS-only `document.querySelector`.** The
  `readBox` helper inside the `drag` handler now uses
  `locator.boundingBox()` so Playwright selectors work for the detect
  target too.

- **`rewriteErrorForTool` did not rewrite `app.*` errors.** The regex
  `/^(page|locator|...)\.[a-zA-Z]+:/` now includes `app`, so errors from
  `eval_main` (which calls `app.evaluate()`) are rewritten with the tool
  name instead of the raw Playwright prefix.

- **Timeout `TIMEOUT` code was never set for most tools.** The outer catch
  used `/^timeout/i` to detect timeout messages, but `rewriteErrorForTool`
  prepends the tool name (e.g. `click: Timeout ...`), so the string no
  longer starts with "timeout". Changed to `/timeout/i` (substring match).

- **`console_logs` required a live session.** The `requireApp()` guard was
  removed. The console buffer persists after `stop_app`, so agents can now
  call `console_logs` post-crash or after a deliberate `stop_app` to read
  any final stderr/stdout without error.

### Changed

- Tool count corrected to **39** everywhere (`server.json`, `README.md`).
  The count was 39 since v0.4.0 but was incorrectly documented as 38.

- `server.json` is now included in the npm package `files` manifest so
  MCP registry metadata is shipped alongside the executable.

## [0.4.0] — 2026-05-11

Maintenance release focused on correctness, security, and keeping pace with
the Playwright and MCP SDK ecosystems.

### Fixed — critical

- **`accessibility_snapshot` was completely broken since Playwright 1.57.0.**
  The old implementation called `win.accessibility.snapshot()`, but
  `Page#accessibility` was removed in Playwright 1.57.0 (Nov 2025) after three
  years of deprecation. The tool now uses `page.ariaSnapshot()` /
  `locator.ariaSnapshot()`, the current Playwright API. The return value is now
  a YAML-formatted string (the format the new API produces) instead of a JSON
  object. The `interestingOnly` option is removed — it has no equivalent in
  the new API.

- **`click` and `hover` MCP schemas incorrectly listed `selector` as
  `required`.** Both tools accept `ref` (from a `snapshot` call) as an
  alternative to `selector`, but a client doing strict schema validation would
  reject a call that only passed `ref`. Fixed by removing `selector` from the
  `required` array.

- **`drop_file` used a manual base64 + `eval_renderer` approach** that
  dispatched synthetic (untrusted) DragEvents and could not reach elements
  hidden behind a Chromium security check. Replaced with Playwright 1.60's
  native `locator.drop({ files: ... })`, which uses the same Chromium CDP
  pipeline as real user drag-and-drop and dispatches trusted events.

### Added

- **`accessibility_snapshot` — `boxes` option.** Pass `boxes: true` to append
  each element's bounding box (`[box=x,y,width,height]`) to the ARIA snapshot.
  New in Playwright 1.60; optimal for AI agents that correlate a11y info with
  spatial positioning.

- **Renderer console entries now include `file` and `line` fields** when
  available. Uses `consoleMessage.location()` (Playwright 1.60 adds the
  non-deprecated `line`/`column` property names). Helps agents pinpoint exactly
  which renderer source line emitted a log message.

### Security

- Bumped `@modelcontextprotocol/sdk` from `^1.0.4` to `^1.29.0`. Relevant
  security fixes included in that range:
  - **v1.25.2**: ReDoS vulnerability in `UriTemplate` regex patterns (CVE).
  - **v1.26.0**: Cross-client response data leak when sharing server/transport
    instances (GHSA-345p-7cg4-v4c7).
  - **v1.29.0**: npm audit fixes; Windows `StdioServerTransport` now hides
    the console window correctly; extension capabilities backport.
- Updated GitHub Actions to latest SHA-pinned versions:
  - `actions/checkout@v4` → `actions/checkout@v6.0.2`
    (`de0fac2e4500dabe0009e67214ff5f5447ce83dd`)
  - `actions/setup-node@v4` → `actions/setup-node@v6.4.0`
    (`48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e`)
- Added `permissions: contents: read` to CI workflow (least-privilege
  `GITHUB_TOKEN` scope).

### Changed

- **Playwright raised to `^1.60.0`** (from `^1.59.1`). v1.60 adds `locator.drop()`,
  `page.ariaSnapshot({ boxes })`, and `consoleMessage.location()` `line`/`column`
  properties — all leveraged in this release.
- **Minimum Node.js raised to `>=20`** (from `>=18`). Node 18 reached end-of-life
  on April 30, 2025 and is no longer receiving security patches.
- **CI Node matrix updated** from `[18, 20, 22]` to `[20, 22, 24]`, reflecting the
  current Active LTS (22) and Current (24) release lines.
- Added `.npmrc` with `engine-strict=true` so `npm install` fails immediately
  on an unsupported Node version rather than continuing silently.

## [0.3.0] — first public release

Big one. This is the first version published for public use. Significant new
capabilities, real fixes for every ship-blocker from internal testing, and
broader tool coverage so the driver works on general Electron apps, not just
the one it was dogfooded against.

### Added — broad general-purpose tool coverage

Tools for driving arbitrary Electron apps that any real test workflow needs:

- `get_attribute` — read element attributes without an eval dance
- `get_value` — read form input values
- `get_bbox` — get an element's bounding box
- `get_computed_style` — read one or more CSS computed properties
- `elements_list` — enumerate elements matching a selector, with text and
  key attributes
- `focused_element` — what currently has focus
- `clear_input` — empty an input
- `select_option` — select from a `<select>` dropdown by value, label, or
  index
- `check` / `uncheck` — toggle checkboxes and radios
- `scroll` — scroll a container or the window by delta or to an absolute
  position
- `scroll_into_view` — ensure an element is visible before interacting
- `set_input_files` — the correct way to test file uploads (no native dialog
  required)
- `accessibility_snapshot` — capture the ARIA tree, optionally rooted at a
  selector, for a11y audits and role-based element discovery
- `windows_list` — enumerate every `BrowserWindow` the app has open
- `switch_window` — route subsequent tool calls to a different window by
  index or title match
- `dialog_handler` — auto-accept or dismiss the next JavaScript
  `alert`/`confirm`/`prompt` dialog

### Added — quality of life

- All tool errors now carry a stable `code` field
  (`NOT_RUNNING`, `ALREADY_RUNNING`, `TIMEOUT`, `NOT_FOUND`, `FILE_NOT_FOUND`,
  `BAD_ARGUMENT`, `UNKNOWN_TOOL`, `ERROR`) so callers can branch
  programmatically instead of regex-matching prose
- Error messages are rewritten to be attributed to the driver tool the user
  actually called (e.g. `wait_for_selector: Timeout 1500ms exceeded` instead
  of `page.waitForSelector: ...`)
- `wait_for_selector` now returns `elapsedMs` on both success and failure,
  and the error message embeds the elapsed-vs-requested timeout
- `click` accepts `force` and `position` options
- `hover` accepts `force` to skip actionability checks
- `keyboard_type` warns if no element has focus when called without a
  `focusSelector`
- Screenshots directory now defaults to the nearest project root (the one
  containing `.git` or `package.json`), not `out/.electron-driver/` as
  before. Much less surprising

### Fixed

- `wait_for_selector` now honours `timeoutMs` correctly. Previously it fell
  through to the default when MCP clients passed the value as a string
- `eval_main` and `eval_renderer` now correctly receive structured `arg`
  payloads (objects, arrays, primitives) instead of a JSON-encoded string
- `get_text` and `exists` now use Playwright's locator engine and accept
  the full selector language (`text=`, `role=`, `:has-text()`, etc)
  instead of only native `document.querySelector`
- `drag` rewritten to use Playwright's native mouse (CDP
  `Input.dispatchMouseEvent`) exclusively, which dispatches real trusted
  Chromium input events. Removed the unreliable synthetic PointerEvent
  dispatch that earlier versions tried as a supplement. Added a React
  fiber-access fallback (`fiberFallback`, on by default) for rare edge
  cases where even real input events don't reach the component. Result
  now includes a `strategy` field and, when `detectSelector` is provided,
  a `detect.moved` boolean so min/max-clamped drags are never silent

### Changed

- Version bumped to 0.3.0 to reflect the significantly expanded tool
  surface. No breaking API changes relative to 0.2

## [0.2.0] — 0.2.1 internal preview

Unified the `eval_renderer`/`eval_main` contract, added pointer-capture drag
handling, added `console_logs`, `wait_for`, `exists`, `get_text`,
`drop_file`, `keyboard_type`, richer `wait_for_selector` returns, populated
`info.viewport`, single-instance-lock detection in `start_app`. Not
publicly released — shipped as 0.3.0 after fixing remaining issues found
during internal testing.

## [0.1.0] — initial prototype

First working version. Minimal surface: `start_app`, `stop_app`, `info`,
`screenshot`, `click`, `type`, `press`, `press_sequence`, `hover`, `drag`,
`wait`, `wait_for_selector`, `eval_renderer`, `eval_main`,
`cleanup_screenshots`. Not publicly released.
