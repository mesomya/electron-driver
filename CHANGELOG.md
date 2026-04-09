# Changelog

All notable changes to `electron-driver` will be documented here. The format
loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/).

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
