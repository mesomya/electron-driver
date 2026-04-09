# electron-driver

[![npm version](https://img.shields.io/npm/v/electron-driver.svg)](https://www.npmjs.com/package/electron-driver)
[![license](https://img.shields.io/npm/l/electron-driver.svg)](./LICENSE)
[![node version](https://img.shields.io/node/v/electron-driver.svg)](https://nodejs.org)

**Drive Electron apps from AI agents.** Click, type, drag, screenshot,
evaluate JavaScript in the renderer or main process, read console logs,
handle multi-window apps, capture accessibility snapshots — all through an
MCP (Model Context Protocol) server that plugs into Claude Code, Claude
Desktop, Cursor, and any other MCP-compatible agent host.

Built on Playwright's experimental `_electron` API. Works with any Electron
app — React, Vue, Svelte, vanilla — as long as you can point it at a
compiled main-process entry.

**Status:** v0.3.0. First public release. 38 tools covering real workflows.

## Why this exists

AI agents can reason about what a desktop app should do, but they can't see
or interact with one on their own. Web browsers have plenty of
agent-automation options; Electron has almost none. This package closes
that gap: give an agent the path to your compiled Electron app and it can
drive it the same way a human would.

Common use cases:

- An agent verifies a feature it just implemented by actually running the
  app and checking the visible result
- Visual regression testing during a refactor
- Accessibility audits via ARIA tree snapshots
- Reproducing bugs from a natural-language description
- Teaching a subagent to iterate on UI until a spec passes

## Install

Requires Node 18+ and an Electron app you've already built.

```bash
npm install electron-driver
```

You don't need to install Playwright browsers separately — `_electron`
drives your Electron binary directly.

## Register with your agent host

### Claude Code (project scope)

Create `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "electron-driver": {
      "command": "npx",
      "args": ["electron-driver"]
    }
  }
}
```

### Claude Code (user scope — available in every project)

```bash
claude mcp add electron-driver --scope user -- npx electron-driver
```

### Claude Desktop / Cursor / other

Add to the host's MCP configuration, pointing at `npx electron-driver` or
the absolute path to `node_modules/electron-driver/index.mjs`.

## Core idea

The server owns **exactly one** Electron session at a time. `start_app`
launches it, everything else drives it, `stop_app` closes it. Screenshots
go to a session directory that is wiped on every `start_app` — no pileup,
no stale artefacts. All tool calls are logged to
`<project>/.electron-driver/driver.log` during a session.

Errors carry a stable `code` field so callers can branch programmatically
without regex-matching prose:

| Code | Meaning |
|---|---|
| `NOT_RUNNING` | A tool needs a running session, but there isn't one |
| `ALREADY_RUNNING` | `start_app` called while a session exists |
| `TIMEOUT` | An action hit its timeout |
| `NOT_FOUND` | Selector or file didn't match |
| `FILE_NOT_FOUND` | Path-based input points at a missing file |
| `BAD_ARGUMENT` | Arguments failed validation |
| `UNKNOWN_TOOL` | Tool name not recognized |
| `ERROR` | Everything else |

## Tools

All 38 tools grouped by purpose. Every selector-based tool uses
Playwright's full selector engine: CSS, `text=`, `role=`, `[aria-label=]`,
`:has-text()`, scoping (`main >> button`), etc.

### Lifecycle

**`start_app`** — launch the app. Takes `main` (absolute path to the
compiled main entry), optional `cwd`, `args`, `env`, `screenshotsDir`,
`timeoutMs`. Returns `{ title, url, viewport, screenshotsDir, logFile }`.
Detects the single-instance-lock failure mode and gives a helpful hint
instead of a raw disconnection error.

**`stop_app`** — close cleanly. Safe on an already-stopped session.

**`info`** — `{ title, url, viewport: {width, height, devicePixelRatio}, uptimeMs }`.
Viewport is populated from `window.innerWidth/innerHeight`.

### Capturing

**`screenshot`** — full-page PNG. Pass `name` (without extension) to
control the filename. Returns `{ path }`.

**`cleanup_screenshots`** — wipe the current session's screenshot directory.

**`console_logs`** — recent renderer console messages (log/info/warn/error/
debug/pageerror) and main-process stdout/stderr. Rolling 1000-entry buffer.
Filter by `source` (`renderer`/`main`/`all`), `type`, and `limit`. Pass
`clear: true` to drain after reading.

### Interaction

**`click`** — click an element. Options: `timeoutMs`, `button`
(`left`/`right`/`middle`), `clickCount`, `force` (skip actionability
checks), `position` (click at an offset inside the element).

**`type`** — `fill` a text input, replacing existing content. Fast but
only works on real inputs. For editors/CodeMirror/contenteditables, use
`keyboard_type`.

**`keyboard_type`** — type as real per-character keydown events. Pass
`focusSelector` to click an element first. Warns in the result if nothing
has focus and no focus selector was passed.

**`press`** — press a key or chord: `"Escape"`, `"Enter"`, `"Control+S"`,
`"Shift+Tab"`, `"Control+Shift+P"`.

**`press_sequence`** — alias for `keyboard_type` with no focus selector.

**`hover`** — hover over an element. Options: `timeoutMs`, `force`.

**`drag`** — drag from one point to another using real Chromium input
events (via Playwright's CDP mouse pipeline). Because these are trusted
browser events, Chromium's pointer pipeline generates matching
`PointerEvent`s as a side effect, so React `onPointerDown`, native
`pointerdown` listeners, `setPointerCapture`, CSS `:hover`/`:active`, and
every other pointer consumer see the drag exactly as if a real user had
performed it. Coordinates are CSS pixels. Pass `detectSelector` and the
driver will measure the element before and after the drag and include
`detect.moved` in the result — the only reliable way to catch drags that
silently hit a min/max clamp.

```json
{
  "from": { "x": 275, "y": 400 },
  "to":   { "x": 420, "y": 400 },
  "detectSelector": ".sidebar-resize-handle"
}
```

If the primary strategy does not move the detect target, the driver
automatically falls back to invoking the React handler directly via
fiber-prop access and dispatching move/up events on both `document` and
`window` — covering all known React splitter patterns. Disable the
fallback with `fiberFallback: false`. The result includes `strategy`
(`"pointer-capture"` or `"react-fiber"`).

**`clear_input`** — empty an input or textarea.

**`select_option`** — select from a `<select>` by `value`, `label`, or
`index`.

**`check`** — check a checkbox or radio. Options: `timeoutMs`, `force`.

**`uncheck`** — uncheck a checkbox.

**`scroll`** — scroll a container (pass `selector`) or the window. Supports
absolute (`x`, `y`) or delta (`dx`, `dy`).

**`scroll_into_view`** — ensure an element is visible. Safe if already is.

**`drop_file`** — simulate dropping a file onto a target via synthetic
`DragEvent`s and a reconstructed `File` with `DataTransfer`. Works for apps
that read the File via web APIs (`FileReader`, `File.text()`, etc). Does
**not** populate `file.path` — apps relying on `webUtils.getPathForFile()`
must use `eval_main` to invoke their own IPC handler directly.

**`set_input_files`** — the correct way to test file upload UI. Sets files
on an `<input type="file">` without a native dialog. Much more reliable
than `drop_file` when the app uses real file inputs.

### Waiting

**`wait`** — fixed pause in milliseconds. Prefer the others.

**`wait_for_selector`** — wait until a selector reaches a state
(`attached`/`detached`/`visible`/`hidden`). Honours `timeoutMs`. Returns
`count`, `box`, and `elapsedMs` on success; the error carries
`elapsed vs requested` on timeout.

**`wait_for`** — poll a JavaScript predicate (function body, use `return`)
until it returns truthy. Options: `timeoutMs`, `pollMs`.

### Checking & reading state

**`exists`** — `{ exists, count }` fast check, no waiting. Accepts the full
selector engine.

**`get_text`** — text content of the first match. Accepts the full selector
engine. Returns `{ exists, text }`.

**`get_attribute`** — read an HTML attribute by name. Returns
`{ exists, value }`.

**`get_value`** — read an input/textarea/select's current value.

**`get_bbox`** — bounding box as `{ x, y, width, height }` in CSS pixels.
Use before dragging or clicking at an offset.

**`get_computed_style`** — read one or more computed CSS properties. Pass
a `properties` array.

**`elements_list`** — enumerate elements matching a selector with their
tag, id, classes, text snippet, box, and key attributes. Great for "what
buttons exist on this screen". Capped at 50 by default; tune via `limit`.

**`focused_element`** — what currently has focus, with tag/id/classes/text
and bounding box. Returns `{ focused: false }` if nothing meaningful has
focus.

**`accessibility_snapshot`** — capture the ARIA tree as JSON. Useful for a11y
audits and finding elements by role. Pass `interestingOnly: false` to
include every node. Pass `root` to snapshot a subtree.

### Multi-window

**`windows_list`** — every `BrowserWindow` the app has open, with id,
title, URL, focus/visibility/state flags.

**`switch_window`** — route subsequent tool calls to a different window.
Pass `index` or `titleMatch`.

### Dialogs

**`dialog_handler`** — install an auto-responder for JavaScript dialogs
(`alert`/`confirm`/`prompt`/`beforeunload`). Pass `action: "accept" | "dismiss"`,
optional `text` for `prompt()`, and `once: true` (default) to
auto-uninstall after the first dialog.

### Evaluation escape hatches

Both `eval_renderer` and `eval_main` use the **same contract**: pass a
function body, use `return` to yield a value, supports `async`/`await`,
and an optional `arg` payload is available as the local `arg` variable.

**`eval_renderer`** — evaluate in the renderer (page) context.

```json
{
  "js": "return document.querySelectorAll(arg.selector).length",
  "arg": { "selector": ".item" }
}
```

**`eval_main`** — evaluate in the Electron main process. The body receives
`electron` (the full Electron module) and `arg`.

```json
{
  "js": "return electron.app.getName()"
}
```

```json
{
  "js": "const w = electron.BrowserWindow.getAllWindows()[0]; w.webContents.send('open-file', arg.path); return true",
  "arg": { "path": "C:/docs/README.md" }
}
```

Use `eval_main` as the escape hatch for everything the DOM side can't
reach: invoking IPC handlers, reading user paths, driving secondary
windows, bypassing native dialogs for apps that use them.

## Selectors cheat sheet

```text
text=Open File              // exact text match
text=/^Save$/               // regex
[aria-label="Settings"]     // ARIA attribute
role=button[name="Close"]   // ARIA role
button:has-text("Save")     // CSS with text predicate
button.primary              // plain CSS
main >> text=Save           // scoped
```

## Selector-engine consistency

Every selector-based tool (`click`, `hover`, `wait_for_selector`,
`get_text`, `get_attribute`, `get_value`, `get_bbox`, `exists`,
`elements_list`, `scroll_into_view`, `select_option`, `check`, `uncheck`,
`set_input_files`) goes through Playwright's full locator engine. Anything
Playwright accepts, these tools accept — including `text=`, `role=`, and
`:has-text()`.

Tools that read low-level DOM via `eval_renderer` under the hood
(`get_computed_style`, `scroll`, `focused_element`, `drop_file`) use
native `document.querySelector` and only support CSS. This is documented
on each tool's description where relevant.

## Troubleshooting

**"Electron process exited immediately after launch."** Another copy of
your app is already running and grabbed the single-instance lock — the
second process quits via `app.requestSingleInstanceLock()`. Close the
running instance (check your taskbar and background processes) and retry.

**`drag` returned `ok:true` but `detect.moved` is `false`.** The most
common cause is a min/max clamp on the target (e.g. a resizable sidebar
at its `MAX_WIDTH`). Try dragging in the opposite direction to confirm
the drag pipeline is working. If it's really not the clamp, the React
fiber fallback should catch it automatically — check the `strategy`
field in the result. If even that returns `moved:false`, use
`eval_renderer` or `eval_main` to invoke the app's own drag API
directly.

**`type` throws "Element is not an `<input>`..."** You're hitting a
button, a div, or a contenteditable. Use `keyboard_type` with a
`focusSelector` instead.

**`click` times out on an element that's clearly there.** Something is
covering it — a modal backdrop, a tooltip, a toast. Use `exists` first to
confirm the count, then try `force: true`, or use `eval_renderer` to check
`getComputedStyle(el).pointerEvents`.

**Native dialogs are invisible.** Playwright cannot see OS-level file
pickers, save dialogs, or system alerts. Use `eval_main` to invoke the
same IPC handler your UI button uses. For JavaScript dialogs
(`alert`/`confirm`/`prompt`), use `dialog_handler` to auto-respond.

**Development build vs compiled app.** This drives the **built** app, not
dev-server output. Run your build command before `start_app`, and rebuild
+ restart the session after source changes.

**One session at a time.** Calling `start_app` while a session is running
returns `ALREADY_RUNNING`. Call `stop_app` first.

**Logs.** Every tool call is logged to
`<project>/.electron-driver/driver.log` while a session is active. Useful
when debugging why an agent got stuck.

**Screenshots location.** Defaults to `<project>/.electron-driver/screenshots`,
where `<project>` is the nearest directory containing `.git` or
`package.json`. Override via `screenshotsDir` on `start_app`.

## Known limitations

- Playwright's `_electron` namespace is officially experimental upstream.
  Occasional launch timeouts on slow machines; usually retrying fixes it.
- Developed primarily on Windows. Mac and Linux should work — Playwright
  handles them — but are less battle-tested. Bug reports welcome.
- `switch_window` routes subsequent calls to the selected window, but the
  console-log buffer is populated from the initial window. Multi-window
  console capture is a planned v0.4 item.
- `drop_file` does not populate `file.path`. Apps using
  `webUtils.getPathForFile()` must use `eval_main` with their own IPC.
- No built-in network-request capture yet — planned for v0.4.

## Implementation notes

For anyone curious or contributing:

- Single Electron session, owned by the MCP server process.
- Screenshots wiped on every `start_app` — intentional.
- Console logs captured into a rolling 1000-entry buffer.
- Every tool call is logged; errors carry a stable `code` field.
- Error messages are rewritten to be attributed to the driver tool, not
  the underlying Playwright method.
- Single-instance-lock detection keys on "process disconnected within 5s
  of launch", which is the actual shape of the failure.
- Evals are async-IIFE wrapped, so `return` works and `await` works.
- `arg` payloads are coerced server-side (JSON-parse on strings) to
  protect against MCP clients that stringify arg fields.
- stderr is used for status messages; stdout is reserved for MCP protocol
  frames.

## Contributing

Issues and PRs welcome. Run locally with:

```bash
cd electron-driver
npm install
node index.mjs  # stdio MCP server
```

The server logs a ready banner to stderr and waits for MCP frames on
stdin. Test it against a real Electron app via any MCP client.

## License

MIT
