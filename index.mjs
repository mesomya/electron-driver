#!/usr/bin/env node
// electron-driver — MCP server for driving Electron apps from AI agents.
//
// Exposes Playwright's experimental _electron API as MCP tools so an agent
// can launch an Electron app, click, type, drag, screenshot, and evaluate JS
// in either the renderer or the main process.
//
// Protocol: stdio MCP server. Register in .mcp.json or Claude Code settings.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { _electron as electron } from 'playwright'
import { mkdirSync, rmSync, existsSync, appendFileSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

// ---- Session state -----------------------------------------------------
// One Electron instance per MCP server process. Single owner, no races.

let app = null
let win = null
let appStartedAt = null
let shotCounter = 0
let shotsDir = null
let logFile = null

// Rolling console-log buffer, populated while a session is alive.
const CONSOLE_BUFFER_MAX = 1000
let consoleBuffer = []

// ---- Logging -----------------------------------------------------------

function initLogDir(baseDir) {
  const dir = path.join(baseDir, '.electron-driver')
  mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, 'driver.log')
  return dir
}

function log(event, data = {}) {
  if (!logFile) return
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...data })
    appendFileSync(logFile, line + '\n')
  } catch {
    // Never let logging break a tool call.
  }
}

function pushConsole(entry) {
  consoleBuffer.push({ t: new Date().toISOString(), ...entry })
  if (consoleBuffer.length > CONSOLE_BUFFER_MAX) {
    consoleBuffer.splice(0, consoleBuffer.length - CONSOLE_BUFFER_MAX)
  }
}

// ---- Helpers -----------------------------------------------------------

function requireApp() {
  if (!app || !win) {
    const e = new Error('No Electron app is running. Call start_app first.')
    e.code = 'NOT_RUNNING'
    throw e
  }
}

function ok(data = {}) {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }] }
}

// Error responses carry a machine-readable `code` so callers can branch
// without regex-matching prose. Codes are stable identifiers; messages are
// human-readable and may change.
function err(message, code = 'ERROR') {
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify({ ok: false, error: message, code }) },
    ],
  }
}

// Walk up from a path looking for a `.git` or `package.json` directory.
// Used to pick a sensible default for screenshotsDir and .electron-driver
// so artefacts land near the repo root instead of inside `out/`.
function findProjectRoot(startDir) {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, '.git')) || existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

// Resolve the path to the Electron binary from the project under test.
// When the driver runs as a standalone package (npx electron-driver, global
// install, etc.), Playwright's _electron.launch() tries require('electron')
// from the DRIVER's node_modules — which doesn't have electron because it's
// a devDependency of the PROJECT, not the driver. This function looks for
// electron in the project's node_modules and returns the executable path.
function resolveElectronBinary(projectDir, userExecPath) {
  // User-provided path takes priority.
  if (userExecPath) {
    if (!existsSync(userExecPath)) {
      throw new Error(`executablePath not found: ${userExecPath}`)
    }
    return userExecPath
  }

  // Walk up from projectDir looking for node_modules/electron.
  const searchDirs = [projectDir]
  // Also look in common parent patterns: if main is at out/main/index.js,
  // projectDir might be out/ — the real project root is likely up one or two levels.
  let d = projectDir
  for (let i = 0; i < 5; i++) {
    const parent = path.dirname(d)
    if (parent === d) break
    searchDirs.push(parent)
    d = parent
  }

  for (const dir of searchDirs) {
    try {
      const req = createRequire(path.join(dir, 'package.json'))
      const electronPath = req('electron')
      if (electronPath && typeof electronPath === 'string') {
        log('electron-binary-resolved', { from: dir, path: electronPath })
        return electronPath
      }
    } catch {
      // Not found in this dir, try next.
    }
  }

  return null // Let Playwright try its own resolution; may still work.
}

// Rewrite Playwright error messages so they're attributed to the driver tool
// the user actually called, not the internal Playwright method. Makes logs
// and error output much easier to understand.
function rewriteErrorForTool(e, toolName) {
  const message = e?.message || String(e)
  // Playwright prefixes errors with things like `page.evaluate: ...`,
  // `locator.click: ...`, `page.waitForSelector: ...`. Replace the prefix
  // with `<toolName>: `.
  return message.replace(
    /^(page|locator|frame|elementHandle|keyboard|mouse)\.[a-zA-Z]+:\s*/,
    `${toolName}: `
  )
}

// Coerce a user-supplied timeout value into a finite number, falling back to
// the default. Accepts numbers, numeric strings, undefined, and null. This is
// necessary because some MCP clients pass numeric fields as strings regardless
// of the declared schema type.
function coerceTimeout(value, defaultMs) {
  if (value === undefined || value === null || value === '') return defaultMs
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : defaultMs
}

// Coerce a user-supplied `arg` payload. Some MCP clients JSON-encode arg
// fields into strings (because the schema permits any type), which means the
// user's function body sees a string instead of the structured value they
// expected. If arg is a string, we attempt to JSON.parse it; on failure it
// is treated as a raw string. Non-string values pass through untouched.
function coerceArg(arg) {
  if (typeof arg !== 'string') return arg
  if (arg === '') return arg
  try {
    return JSON.parse(arg)
  } catch {
    return arg
  }
}

// Permissive JSON schema hint for arbitrary arg payloads.
const ARG_SCHEMA = {
  type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
  description:
    'Arbitrary JSON-serializable value exposed as `arg` inside the body. Objects, arrays, primitives, and null all work.',
}

function assertPoint(label, pt) {
  if (!pt || typeof pt !== 'object') {
    throw new Error(`${label} must be an object like { x: number, y: number }`)
  }
  if (typeof pt.x !== 'number' || !Number.isFinite(pt.x)) {
    throw new Error(`${label}.x must be a finite number`)
  }
  if (typeof pt.y !== 'number' || !Number.isFinite(pt.y)) {
    throw new Error(`${label}.y must be a finite number`)
  }
}

async function currentViewport() {
  return await win.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }))
}

// Classifies a launch failure to detect the single-instance-lock pattern,
// where Electron's second-instance handler exits the second process with 0
// almost immediately, leaving Playwright with a dead target.
function diagnoseLaunchError(e, elapsedMs) {
  const msg = String(e?.message || e)
  const looksLikeDeadTarget =
    /disconnected|has been closed|target.*closed|Protocol error/i.test(msg) &&
    elapsedMs < 5000
  if (looksLikeDeadTarget) {
    return (
      'Electron process exited or disconnected immediately after launch. ' +
      'The most common cause is a single-instance lock: another copy of this app is already running, ' +
      "so the second process calls app.quit() via Electron's requestSingleInstanceLock handoff. " +
      'Close the running instance (check your taskbar and background processes) and try again. ' +
      'Original error: ' +
      msg
    )
  }
  return msg
}

// Primary drag strategy: Playwright's `mouse` API, which dispatches input
// events via Chromium's CDP `Input.dispatchMouseEvent`. These are real,
// trusted browser input events — Chromium's pointer pipeline automatically
// generates matching PointerEvents as a side effect, so React, native
// listeners, `setPointerCapture`, CSS `:hover`/`:active`, and every other
// consumer of pointer events see the drag exactly as if a real user had
// performed it.
//
// Earlier versions of this driver tried to supplement mouse events with
// synthetic PointerEvent dispatches on the captured element and on
// `window`. That was unreliable for two reasons:
//   1. Synthetic events have `isTrusted=false` and can't trigger default
//      actions like pointer capture or focus changes.
//   2. Many splitters attach their drag listeners to `document` (not
//      `window`), so dispatching on `window` never reached them.
// The clean fix is to trust Chromium's native pipeline and let it generate
// pointer events automatically — which is exactly what real user input
// does. Everything downstream just works.
//
// The React-fiber fallback (see `dragViaReactFiber` below) remains as a
// last-resort escape hatch for environments where CDP input dispatch is
// unavailable or contended (e.g. DevTools already holding the debugger).
async function dragWithPointerCapture(from, to, steps) {
  // Capture the tag under the start point for the return value (useful
  // debugging info, lets callers confirm they hit the intended target).
  const capturedTag = await win.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el ? el.tagName : null
    },
    { x: from.x, y: from.y }
  )

  // Hover to the start position first — matches real UX, so any CSS
  // `:hover`, `onPointerEnter`, or tooltip-on-hover logic runs before the
  // drag starts. Some splitters only arm themselves on hover.
  await win.mouse.move(from.x, from.y)

  // Press.
  await win.mouse.down()

  // Interpolated move. Playwright's `mouse.move` with `steps` already
  // generates intermediate events, but we do our own loop here so step
  // count is explicit and documented. (Also, some splitters only read the
  // final clientX/Y per event loop tick, so discrete per-step moves are
  // functionally equivalent.)
  const stepCount = Math.max(1, steps | 0)
  for (let i = 1; i <= stepCount; i++) {
    const t = i / stepCount
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    await win.mouse.move(x, y)
  }

  // Release.
  await win.mouse.up()

  return { tag: capturedTag }
}

// React-fiber fallback: last-resort drag path for environments where real
// mouse dispatch doesn't reach a React component. We find the React handler
// directly on the DOM node (React stores it as `__reactProps$...`) and call
// it with a minimal synthetic event. After the handler runs, it typically
// attaches native listeners — most commonly to `document` (React itself
// attaches there) or `window` — which we then drive with real events
// dispatched on BOTH targets so we cover either pattern.
async function dragViaReactFiber(fromSelector, from, to, steps) {
  const invoked = await win.evaluate(
    ({ selector, from }) => {
      const el = selector
        ? document.querySelector(selector)
        : document.elementFromPoint(from.x, from.y)
      if (!el) return { ok: false, reason: 'no element at target' }
      const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps'))
      if (!propsKey) return { ok: false, reason: 'no react props' }
      const props = el[propsKey]
      const handler = props?.onPointerDown || props?.onMouseDown
      if (typeof handler !== 'function')
        return { ok: false, reason: 'no onPointerDown or onMouseDown' }

      // Minimal synthetic event the handler will see.
      const rect = el.getBoundingClientRect()
      const cx = from?.x ?? rect.x + rect.width / 2
      const cy = from?.y ?? rect.y + rect.height / 2
      const fakeEvent = {
        clientX: cx,
        clientY: cy,
        screenX: cx,
        screenY: cy,
        pageX: cx,
        pageY: cy,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        target: el,
        currentTarget: el,
        preventDefault: () => {},
        stopPropagation: () => {},
        nativeEvent: { clientX: cx, clientY: cy, button: 0, buttons: 1 },
      }
      try {
        handler(fakeEvent)
      } catch (e) {
        return { ok: false, reason: 'handler threw: ' + String(e?.message || e) }
      }
      return { ok: true, tag: el.tagName }
    },
    { selector: fromSelector, from }
  )

  if (!invoked?.ok) return invoked

  // Drive pointermove / pointerup on BOTH document and window — different
  // splitters listen on different targets. Dispatching on both is cheap
  // and covers the common patterns.
  const dispatchBoth = async (type, x, y, buttons) => {
    await win.evaluate(
      ({ type, x, y, buttons }) => {
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          pageX: x,
          pageY: y,
          pointerType: 'mouse',
          pointerId: 1,
          isPrimary: true,
          button: type === 'pointerup' ? 0 : -1,
          buttons,
          view: window,
        }
        document.dispatchEvent(new PointerEvent(type, init))
        window.dispatchEvent(new PointerEvent(type, init))
        const mouseType = type.replace('pointer', 'mouse')
        document.dispatchEvent(new MouseEvent(mouseType, init))
        window.dispatchEvent(new MouseEvent(mouseType, init))
      },
      { type, x, y, buttons }
    )
  }

  const stepCount = Math.max(1, steps | 0)
  for (let i = 1; i <= stepCount; i++) {
    const t = i / stepCount
    const x = from.x + (to.x - from.x) * t
    const y = from.y + (to.y - from.y) * t
    await dispatchBoth('pointermove', x, y, 1)
  }

  await dispatchBoth('pointerup', to.x, to.y, 0)

  return { ok: true, tag: invoked.tag, viaFiber: true }
}

// ---- Tool implementations ---------------------------------------------

const tools = {
  start_app: {
    description:
      'Launch an Electron app via Playwright. Must be called before any other driving tool. Pass the absolute path to the compiled main process entry (e.g. out/main/index.js). Wipes the screenshots directory on each fresh start. Detects the single-instance-lock failure mode and gives a helpful hint.',
    inputSchema: {
      type: 'object',
      properties: {
        main: {
          type: 'string',
          description: 'Absolute path to the Electron main process entry file.',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory for the Electron process. Defaults to the parent directory of `main`.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra CLI args to pass to Electron, appended after `main`.',
        },
        screenshotsDir: {
          type: 'string',
          description:
            'Directory to save screenshots in. Defaults to <cwd>/.electron-driver/screenshots. Wiped on each fresh start.',
        },
        env: {
          type: 'object',
          description: 'Extra environment variables to set for the Electron process.',
          additionalProperties: { type: 'string' },
        },
        timeoutMs: {
          type: 'number',
          description: 'Launch timeout in milliseconds. Default 30000.',
        },
        executablePath: {
          type: 'string',
          description:
            'Absolute path to the Electron binary. Usually not needed — the driver auto-resolves it from the project\'s node_modules. Override if auto-resolution fails (e.g. custom Electron fork, monorepo layout).',
        },
      },
      required: ['main'],
    },
    handler: async ({ main, cwd, args = [], screenshotsDir, env, timeoutMs, executablePath: userExecPath }) => {
      if (app) {
        return err(
          'An Electron app is already running. Call stop_app first.',
          'ALREADY_RUNNING'
        )
      }
      if (!path.isAbsolute(main)) {
        return err(`\`main\` must be an absolute path. Got: ${main}`, 'BAD_ARGUMENT')
      }
      if (!existsSync(main)) {
        return err(`Main entry file not found: ${main}`, 'FILE_NOT_FOUND')
      }

      // `cwd` is the directory Electron runs in. By default we step up one
      // level from `main` (so out/main/index.js → out/), which matches what
      // most build tools expect. Artefacts (screenshots, logs) go into the
      // nearest project root instead — otherwise they'd bury themselves
      // inside `out/.electron-driver/` which is surprising.
      const resolvedCwd = cwd || path.dirname(path.dirname(main))
      const artefactRoot = findProjectRoot(resolvedCwd)
      initLogDir(artefactRoot)

      shotsDir = screenshotsDir || path.join(artefactRoot, '.electron-driver', 'screenshots')
      rmSync(shotsDir, { recursive: true, force: true })
      mkdirSync(shotsDir, { recursive: true })
      shotCounter = 0
      consoleBuffer = []

      // Resolve the Electron binary from the project's node_modules so the
      // driver works as a standalone package (npx, global install) without
      // requiring electron as its own dependency.
      let electronBinary
      try {
        electronBinary = resolveElectronBinary(resolvedCwd, userExecPath)
      } catch (e) {
        return err(e.message, 'FILE_NOT_FOUND')
      }

      const launchOpts = {
        args: [main, ...args],
        cwd: resolvedCwd,
        env: { ...process.env, ...(env || {}) },
        timeout: timeoutMs ?? 30000,
      }
      if (electronBinary) {
        launchOpts.executablePath = electronBinary
      }

      log('launching', { main, cwd: resolvedCwd, electronBinary: electronBinary || 'auto' })
      const launchStart = Date.now()
      try {
        app = await electron.launch(launchOpts)
      } catch (e) {
        const elapsed = Date.now() - launchStart
        const message = diagnoseLaunchError(e, elapsed)
        log('launch-error', { elapsed, message })
        app = null
        return err(message)
      }

      try {
        win = await app.firstWindow()
        await win.waitForLoadState('domcontentloaded')
      } catch (e) {
        const elapsed = Date.now() - launchStart
        const message = diagnoseLaunchError(e, elapsed)
        try { await app.close() } catch {}
        app = null
        win = null
        return err(message)
      }

      appStartedAt = Date.now()

      // Wire up console capture — renderer and main process both.
      win.on('console', (msg) => {
        pushConsole({
          source: 'renderer',
          type: msg.type(),
          text: msg.text(),
        })
      })
      win.on('pageerror', (e) => {
        pushConsole({ source: 'renderer', type: 'error', text: String(e?.message || e) })
      })
      try {
        const proc = app.process()
        if (proc && proc.stderr) {
          proc.stderr.on('data', (chunk) => {
            pushConsole({ source: 'main', type: 'stderr', text: chunk.toString() })
          })
        }
        if (proc && proc.stdout) {
          proc.stdout.on('data', (chunk) => {
            pushConsole({ source: 'main', type: 'stdout', text: chunk.toString() })
          })
        }
      } catch {
        // Main-process stdio capture is best-effort.
      }

      const viewport = await currentViewport()
      const info = {
        title: await win.title(),
        url: win.url(),
        viewport,
        screenshotsDir: shotsDir,
        logFile,
      }
      log('ready', info)
      return ok(info)
    },
  },

  stop_app: {
    description:
      'Close the running Electron app cleanly. Safe to call even if no app is running.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (!app) return ok({ alreadyStopped: true })
      log('stopping')
      try {
        await app.close()
      } catch (e) {
        log('stop-error', { error: String(e?.message || e) })
      }
      app = null
      win = null
      return ok({ stopped: true })
    },
  },

  info: {
    description:
      'Get current window title, URL, viewport size (populated from window.innerWidth/innerHeight), uptime, and devicePixelRatio.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      requireApp()
      return ok({
        title: await win.title(),
        url: win.url(),
        viewport: await currentViewport(),
        uptimeMs: Date.now() - appStartedAt,
      })
    },
  },

  screenshot: {
    description:
      'Capture a full-page PNG of the current window. Returns the absolute path. Pass `name` to control the filename (without extension).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Filename without extension.' },
        fullPage: { type: 'boolean', description: 'Default true.' },
      },
    },
    handler: async ({ name, fullPage = true }) => {
      requireApp()
      shotCounter++
      const safeName = name || `shot-${String(shotCounter).padStart(3, '0')}`
      const file = path.join(shotsDir, `${safeName}.png`)
      await win.screenshot({ path: file, fullPage })
      return ok({ path: file })
    },
  },

  cleanup_screenshots: {
    description:
      'Delete all screenshots from the current session directory. Useful between test phases to keep storage tidy.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (!shotsDir) return err('No active session.')
      rmSync(shotsDir, { recursive: true, force: true })
      mkdirSync(shotsDir, { recursive: true })
      shotCounter = 0
      return ok({ cleaned: shotsDir })
    },
  },

  click: {
    description:
      'Click an element matching a Playwright selector. Supports CSS, text=, [aria-label=...], role selectors, etc. Pass `force: true` to skip actionability checks when an overlay is in the way.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Default left.',
        },
        clickCount: { type: 'number', description: 'Default 1. Use 2 for double-click.' },
        force: {
          type: 'boolean',
          description:
            'Skip actionability checks. Useful when an overlay is intercepting pointer events.',
        },
        position: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          description:
            'Click at an offset inside the element (default is centre). Useful for hitting specific sub-regions.',
        },
      },
      required: ['selector'],
    },
    handler: async ({
      selector,
      timeoutMs,
      button = 'left',
      clickCount = 1,
      force = false,
      position,
    }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      const opts = { timeout, button, clickCount, force }
      if (position) opts.position = position
      await win.click(selector, opts)
      return ok()
    },
  },

  type: {
    description:
      "Fill a text input matching a selector, REPLACING existing content. Uses Playwright's `fill`, which is fast but only works on real <input>/<textarea>/[contenteditable] elements. For keyboard-level typing (shortcuts, CodeMirror, contenteditables, or appending to existing text), use `keyboard_type` instead.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
      },
      required: ['selector', 'text'],
    },
    handler: async ({ selector, text, timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      await win.fill(selector, text, { timeout })
      return ok()
    },
  },

  keyboard_type: {
    description:
      'Type a literal string as real keyboard events. Unlike `type` (which uses fill), this dispatches per-character keydown/keypress/keyup events — works with CodeMirror, contenteditables, editors, and anything that listens to keydown. Optionally focus a selector first.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        focusSelector: {
          type: 'string',
          description:
            'Optional selector to click (and thus focus) before typing. If omitted, types into whatever is currently focused.',
        },
        delayMs: { type: 'number', description: 'Per-key delay, default 0.' },
        timeoutMs: { type: 'number', description: 'Focus timeout. Default 5000.' },
      },
      required: ['text'],
    },
    handler: async ({ text, focusSelector, delayMs = 0, timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      if (focusSelector) {
        await win.click(focusSelector, { timeout })
      }
      // If no focusSelector was passed, check whether anything actually has
      // focus — typing into nothing is almost always a bug and the caller
      // should know.
      let warning = null
      if (!focusSelector) {
        const focusInfo = await win.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return { focused: false }
          return {
            focused: true,
            tag: el.tagName,
            type: el.getAttribute('type'),
            id: el.id || null,
          }
        })
        if (!focusInfo.focused) {
          warning =
            'No element has focus. keyboard_type will dispatch key events but they may go nowhere. Pass focusSelector to be explicit.'
        }
      }
      await win.keyboard.type(text, { delay: delayMs })
      return warning ? ok({ warning }) : ok()
    },
  },

  press: {
    description:
      'Press a keyboard key or chord in the window. Examples: "Escape", "Enter", "Control+S", "Shift+Tab", "Control+Shift+P".',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
      },
      required: ['key'],
    },
    handler: async ({ key }) => {
      requireApp()
      await win.keyboard.press(key)
      return ok()
    },
  },

  press_sequence: {
    description:
      'Alias for keyboard_type with no focus selector. Types a literal string into the currently focused element as keyboard events. Kept for backwards compatibility.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        delayMs: { type: 'number', description: 'Per-key delay, default 0.' },
      },
      required: ['text'],
    },
    handler: async ({ text, delayMs = 0 }) => {
      requireApp()
      await win.keyboard.type(text, { delay: delayMs })
      return ok()
    },
  },

  hover: {
    description:
      'Hover the mouse over an element matching a selector. Pass `force: true` to skip Playwright\'s actionability checks — useful when a tooltip, backdrop, or transient overlay intercepts pointer events and you want to hover anyway.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
        force: {
          type: 'boolean',
          description:
            'Skip actionability checks (default false). Set true if an overlay is intercepting pointer events.',
        },
      },
      required: ['selector'],
    },
    handler: async ({ selector, timeoutMs, force = false }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      await win.hover(selector, { timeout, force })
      return ok()
    },
  },

  drag: {
    description:
      "Drag from one point to another using real Chromium input events (via Playwright's CDP mouse pipeline). Because these are trusted browser events, they automatically generate matching PointerEvents — so React `onPointerDown`, native `pointerdown` listeners, `setPointerCapture`, CSS `:hover`/`:active`, and every other pointer consumer all see the drag exactly as they would from a real user. Coordinates are CSS pixels. Pass `detectSelector` to have the driver measure that element before and after the drag and include the movement delta in the result — the only reliable way to catch drags that silently hit a min/max clamp. If the primary strategy does not move the detect target (and a `detectSelector` was given), the driver automatically falls back to invoking the React handler directly via fiber-prop access and then dispatching move/up events on both `document` and `window`. Disable the fallback with `fiberFallback: false`. The result includes a `strategy` field indicating which path worked (`pointer-capture` or `react-fiber`).",
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        to: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' } },
          required: ['x', 'y'],
        },
        steps: { type: 'number', description: 'Intermediate move steps, default 15.' },
        detectSelector: {
          type: 'string',
          description:
            "Optional. If provided, the driver reads this element's bounding box before and after the drag and returns the delta so the caller can tell whether anything actually moved.",
        },
        fiberFallback: {
          type: 'boolean',
          description:
            'If the primary drag strategy fails to move detectSelector, try invoking the React handler directly via fiber-prop access. Default true. Set to false to disable.',
        },
      },
      required: ['from', 'to'],
    },
    handler: async ({ from, to, steps = 15, detectSelector, fiberFallback = true }) => {
      requireApp()
      assertPoint('from', from)
      assertPoint('to', to)

      // Helper to read bounding box of the detect target.
      const readBox = async () => {
        if (!detectSelector) return null
        return await win.evaluate((sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }, detectSelector)
      }

      const didMove = (before, after) =>
        !!before &&
        !!after &&
        (Math.abs(before.x - after.x) > 0.5 ||
          Math.abs(before.y - after.y) > 0.5 ||
          Math.abs(before.width - after.width) > 0.5 ||
          Math.abs(before.height - after.height) > 0.5)

      const before = await readBox()
      const capture = await dragWithPointerCapture(from, to, steps)
      let after = await readBox()
      let moved = didMove(before, after)
      let strategy = 'pointer-capture'

      // If the primary strategy didn't move the detect target and a fiber
      // fallback is allowed, try calling the React handler directly. This is
      // the nuclear option for React components that only respond to their
      // own synthetic event system. No-op if the element isn't React-managed.
      if (detectSelector && !moved && fiberFallback) {
        const fiberResult = await dragViaReactFiber(detectSelector, from, to, steps)
        if (fiberResult?.ok) {
          after = await readBox()
          moved = didMove(before, after)
          strategy = 'react-fiber'
        }
      }

      const result = {
        from,
        to,
        steps,
        strategy,
        capturedTag: capture?.tag ?? null,
      }
      if (detectSelector) {
        result.detect = { before, after, moved }
      }
      return ok(result)
    },
  },

  wait: {
    description: 'Pause for N milliseconds. Prefer wait_for_selector or wait_for when possible.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number' } },
      required: ['ms'],
    },
    handler: async ({ ms }) => {
      await new Promise((r) => setTimeout(r, ms))
      return ok()
    },
  },

  wait_for_selector: {
    description:
      'Wait until an element matching a selector appears (or reaches a given state: attached/detached/visible/hidden). Returns element count and the bounding box of the first match so you do not need a follow-up eval. Honours timeoutMs (default 5000).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        state: {
          type: 'string',
          enum: ['attached', 'detached', 'visible', 'hidden'],
          description: 'Default visible.',
        },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, state = 'visible', timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      log('wait_for_selector', { selector, state, timeout, rawTimeoutMs: timeoutMs })
      const started = Date.now()
      try {
        await win.waitForSelector(selector, { state, timeout })
      } catch (e) {
        const elapsedMs = Date.now() - started
        const rewritten = rewriteErrorForTool(e, 'wait_for_selector')
        return err(
          `${rewritten} (elapsed ${elapsedMs}ms, requested ${timeout}ms)`,
          'TIMEOUT'
        )
      }
      const elapsedMs = Date.now() - started
      const info = await win.evaluate((sel) => {
        const els = document.querySelectorAll(sel)
        if (!els.length) return { count: 0, box: null }
        const r = els[0].getBoundingClientRect()
        return {
          count: els.length,
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        }
      }, selector)
      return ok({ selector, state, elapsedMs, ...info })
    },
  },

  wait_for: {
    description:
      'Poll a JavaScript predicate in the renderer until it returns truthy, then return its value. The predicate is a function body; use `return` to yield a value. Example body: `return document.querySelectorAll(".item").length >= 3`.',
    inputSchema: {
      type: 'object',
      properties: {
        js: {
          type: 'string',
          description: 'Function body. Use `return` to yield the predicate result.',
        },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
        pollMs: { type: 'number', description: 'Poll interval, default 100.' },
      },
      required: ['js'],
    },
    handler: async ({ js, timeoutMs, pollMs = 100 }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      const value = await win.waitForFunction(
        (body) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function(body)
          return fn()
        },
        js,
        { timeout, polling: pollMs }
      )
      const resolved = await value.jsonValue().catch(() => null)
      return ok({ value: resolved })
    },
  },

  exists: {
    description:
      'Fast check for whether any element matches a selector, plus the count. Uses Playwright locators so it accepts the full selector engine (CSS, text=, role=, :has-text(), etc). Does not wait. Returns { exists, count }.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
      },
      required: ['selector'],
    },
    handler: async ({ selector }) => {
      requireApp()
      const count = await win.locator(selector).count()
      return ok({ exists: count > 0, count })
    },
  },

  get_attribute: {
    description:
      'Read an attribute from the first element matching a selector. Returns { exists, value }. For reading element text content, use get_text. For reading form input values, use get_value.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        name: { type: 'string', description: 'Attribute name, e.g. "href", "aria-label".' },
      },
      required: ['selector', 'name'],
    },
    handler: async ({ selector, name }) => {
      requireApp()
      const loc = win.locator(selector)
      const count = await loc.count()
      if (count === 0) return ok({ exists: false, value: null })
      const value = await loc.first().getAttribute(name)
      return ok({ exists: true, value })
    },
  },

  get_value: {
    description:
      'Read the current value of a form input, textarea, or select matching a selector. Returns { exists, value }. For checkboxes/radios, see `is_checked` via eval_renderer (or use get_attribute for type-specific attrs).',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
    handler: async ({ selector }) => {
      requireApp()
      const loc = win.locator(selector)
      const count = await loc.count()
      if (count === 0) return ok({ exists: false, value: null })
      const value = await loc.first().inputValue()
      return ok({ exists: true, value })
    },
  },

  get_bbox: {
    description:
      'Get the bounding box of the first element matching a selector, in CSS pixels. Returns { exists, box: {x, y, width, height} }. Useful before dragging or clicking at a specific offset, without having to eval getBoundingClientRect.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
    handler: async ({ selector }) => {
      requireApp()
      const loc = win.locator(selector)
      const count = await loc.count()
      if (count === 0) return ok({ exists: false, box: null })
      const box = await loc.first().boundingBox()
      return ok({ exists: true, box })
    },
  },

  get_computed_style: {
    description:
      'Read computed CSS property values from the first element matching a selector. Returns { exists, styles } where styles is an object mapping each requested property to its computed value. Example properties: "background-color", "font-family", "display".',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of CSS property names to read.',
        },
      },
      required: ['selector', 'properties'],
    },
    handler: async ({ selector, properties }) => {
      requireApp()
      const result = await win.evaluate(
        ({ sel, props }) => {
          const el = document.querySelector(sel)
          if (!el) return { exists: false, styles: null }
          const cs = getComputedStyle(el)
          const styles = {}
          for (const p of props) styles[p] = cs.getPropertyValue(p)
          return { exists: true, styles }
        },
        { sel: selector, props: properties }
      )
      return ok(result)
    },
  },

  elements_list: {
    description:
      'Enumerate elements matching a selector, returning basic info about each (tag, text snippet, id, key attributes, bounding box). Great for "what buttons are on this screen" or "give me all list items". Capped at 50 by default.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        limit: { type: 'number', description: 'Max elements to return, default 50.' },
        attributes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Extra attributes to include for each element (default ["aria-label","role","href","title"]).',
        },
      },
      required: ['selector'],
    },
    handler: async ({ selector, limit = 50, attributes }) => {
      requireApp()
      const extraAttrs = attributes || ['aria-label', 'role', 'href', 'title']
      const result = await win.evaluate(
        ({ sel, limit, attrs }) => {
          const els = Array.from(document.querySelectorAll(sel)).slice(0, limit)
          return els.map((el) => {
            const r = el.getBoundingClientRect()
            const obj = {
              tag: el.tagName,
              id: el.id || null,
              classes: el.className || null,
              text: (el.textContent || '').trim().slice(0, 80),
              box: { x: r.x, y: r.y, width: r.width, height: r.height },
            }
            for (const a of attrs) {
              const v = el.getAttribute(a)
              if (v != null) obj[a] = v
            }
            return obj
          })
        },
        { sel: selector, limit, attrs: extraAttrs }
      )
      return ok({ count: result.length, elements: result })
    },
  },

  focused_element: {
    description:
      'Return information about the currently focused element: tag, id, classes, text snippet, and bounding box. Returns { focused: false } if nothing meaningful has focus (document.body).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      requireApp()
      const info = await win.evaluate(() => {
        const el = document.activeElement
        if (!el || el === document.body) return { focused: false }
        const r = el.getBoundingClientRect()
        return {
          focused: true,
          tag: el.tagName,
          id: el.id || null,
          classes: el.className || null,
          type: el.getAttribute('type') || null,
          name: el.getAttribute('name') || null,
          text: (el.textContent || '').trim().slice(0, 80),
          box: { x: r.x, y: r.y, width: r.width, height: r.height },
        }
      })
      return ok(info)
    },
  },

  clear_input: {
    description:
      'Clear the value of an input or textarea matching a selector. Equivalent to selecting all and deleting.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      await win.fill(selector, '', { timeout })
      return ok()
    },
  },

  select_option: {
    description:
      'Select an option in a <select> dropdown. Pass `value` (the option\'s value attribute), `label` (its visible text), or `index` (zero-based). At least one must be provided.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        value: { type: 'string' },
        label: { type: 'string' },
        index: { type: 'number' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, value, label, index, timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      const arg = {}
      if (value !== undefined) arg.value = value
      if (label !== undefined) arg.label = label
      if (index !== undefined) arg.index = index
      if (Object.keys(arg).length === 0) {
        return err(
          'select_option needs at least one of value/label/index.',
          'BAD_ARGUMENT'
        )
      }
      const selected = await win.selectOption(selector, arg, { timeout })
      return ok({ selected })
    },
  },

  check: {
    description: 'Check a checkbox or radio button matching a selector. No-op if already checked.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
        force: { type: 'boolean', description: 'Skip actionability checks.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, timeoutMs, force = false }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      await win.check(selector, { timeout, force })
      return ok()
    },
  },

  uncheck: {
    description: 'Uncheck a checkbox matching a selector. No-op if already unchecked.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
        force: { type: 'boolean', description: 'Skip actionability checks.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, timeoutMs, force = false }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      await win.uncheck(selector, { timeout, force })
      return ok()
    },
  },

  scroll: {
    description:
      'Scroll an element (if selector is given) or the window (if not). Pass `x`/`y` for an absolute scroll position, or `dx`/`dy` for a delta from the current position. Use scroll_into_view instead if you just want to make an element visible.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Container to scroll. Omit to scroll the window.',
        },
        x: { type: 'number', description: 'Absolute scrollLeft position.' },
        y: { type: 'number', description: 'Absolute scrollTop position.' },
        dx: { type: 'number', description: 'Delta X (added to current scroll).' },
        dy: { type: 'number', description: 'Delta Y (added to current scroll).' },
      },
    },
    handler: async ({ selector, x, y, dx, dy }) => {
      requireApp()
      const result = await win.evaluate(
        ({ selector, x, y, dx, dy }) => {
          const target = selector ? document.querySelector(selector) : window
          if (!target) return { exists: false }
          const isWindow = target === window
          const get = () =>
            isWindow
              ? { x: window.scrollX, y: window.scrollY }
              : { x: target.scrollLeft, y: target.scrollTop }
          const before = get()
          if (x !== undefined || y !== undefined) {
            if (isWindow) {
              window.scrollTo(x ?? before.x, y ?? before.y)
            } else {
              if (x !== undefined) target.scrollLeft = x
              if (y !== undefined) target.scrollTop = y
            }
          }
          if (dx !== undefined || dy !== undefined) {
            if (isWindow) {
              window.scrollBy(dx || 0, dy || 0)
            } else {
              if (dx !== undefined) target.scrollLeft += dx
              if (dy !== undefined) target.scrollTop += dy
            }
          }
          return { exists: true, before, after: get() }
        },
        { selector, x, y, dx, dy }
      )
      if (!result.exists) return err(`No element matches selector: ${selector}`, 'NOT_FOUND')
      return ok(result)
    },
  },

  scroll_into_view: {
    description:
      'Scroll the first element matching a selector into view if needed. Safe to call even if the element is already visible.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      await win.locator(selector).first().scrollIntoViewIfNeeded({ timeout })
      return ok()
    },
  },

  set_input_files: {
    description:
      'Set files on an <input type="file"> without triggering the native file picker. This is the CORRECT way to test file upload UI in Electron — much more reliable than drop_file. Pass one or more absolute file paths.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of absolute file paths.',
        },
        timeoutMs: { type: 'number', description: 'Default 5000.' },
      },
      required: ['selector', 'files'],
    },
    handler: async ({ selector, files, timeoutMs }) => {
      requireApp()
      const timeout = coerceTimeout(timeoutMs, 5000)
      for (const f of files || []) {
        if (!path.isAbsolute(f)) {
          return err(`All file paths must be absolute. Got: ${f}`, 'BAD_ARGUMENT')
        }
        if (!existsSync(f)) return err(`File not found: ${f}`, 'FILE_NOT_FOUND')
      }
      await win.setInputFiles(selector, files, { timeout })
      return ok({ files })
    },
  },

  accessibility_snapshot: {
    description:
      'Capture the accessibility tree of the current page as JSON. Useful for testing screen-reader behaviour, finding elements by role, or auditing for missing ARIA labels. Optionally pass `interestingOnly: false` to include every node, not just interesting ones.',
    inputSchema: {
      type: 'object',
      properties: {
        interestingOnly: {
          type: 'boolean',
          description:
            'Filter to interactive/labelled nodes only. Default true (matches Playwright default).',
        },
        root: {
          type: 'string',
          description:
            'Optional selector. If given, snapshot is rooted at that element instead of the full page.',
        },
      },
    },
    handler: async ({ interestingOnly = true, root }) => {
      requireApp()
      let rootHandle
      if (root) {
        rootHandle = await win.locator(root).first().elementHandle()
        if (!rootHandle) return err(`No element matches selector: ${root}`, 'NOT_FOUND')
      }
      const snapshot = await win.accessibility.snapshot({
        interestingOnly,
        root: rootHandle,
      })
      return ok({ snapshot })
    },
  },

  windows_list: {
    description:
      'List every BrowserWindow the app has open, with title, URL, id, and whether it is focused/minimized/maximized. For single-window apps this returns one entry.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      requireApp()
      const result = await app.evaluate(async ({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows().map((w, i) => ({
          index: i,
          id: w.id,
          title: w.getTitle(),
          url: w.webContents.getURL(),
          focused: w.isFocused(),
          minimized: w.isMinimized(),
          maximized: w.isMaximized(),
          visible: w.isVisible(),
          destroyed: w.isDestroyed(),
        }))
      })
      return ok({ count: result.length, windows: result })
    },
  },

  switch_window: {
    description:
      'Make a different BrowserWindow the "current" one that subsequent tools drive. Pass `index` (from windows_list) or `titleMatch` (substring of window title). The driver will focus the target window and route all future click/type/eval calls to it.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number' },
        titleMatch: { type: 'string' },
      },
    },
    handler: async ({ index, titleMatch }) => {
      requireApp()
      const pages = app.windows()
      if (!pages.length) return err('No windows available.', 'NOT_FOUND')
      let target = null
      if (typeof index === 'number') {
        if (index < 0 || index >= pages.length) {
          return err(`Index ${index} out of range (0..${pages.length - 1}).`, 'BAD_ARGUMENT')
        }
        target = pages[index]
      } else if (titleMatch) {
        for (const p of pages) {
          const title = await p.title().catch(() => '')
          if (title.includes(titleMatch)) {
            target = p
            break
          }
        }
        if (!target) return err(`No window title contains: ${titleMatch}`, 'NOT_FOUND')
      } else {
        return err('Pass index or titleMatch.', 'BAD_ARGUMENT')
      }
      win = target
      try {
        await win.bringToFront()
      } catch {}
      return ok({
        title: await win.title(),
        url: win.url(),
      })
    },
  },

  dialog_handler: {
    description:
      'Install an auto-responder for JavaScript dialogs (alert/confirm/prompt/beforeunload). Once set, the next dialog(s) will be auto-accepted or dismissed without a human. Pass `action: "accept"` or `"dismiss"`, optional `text` for prompts, and `once: true` to auto-uninstall after the first dialog (default true).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['accept', 'dismiss'], description: 'Default accept.' },
        text: { type: 'string', description: 'Text to enter in a prompt() dialog.' },
        once: {
          type: 'boolean',
          description: 'Auto-uninstall after first dialog. Default true.',
        },
      },
    },
    handler: async ({ action = 'accept', text, once = true }) => {
      requireApp()
      const handler = async (dialog) => {
        try {
          if (action === 'accept') await dialog.accept(text)
          else await dialog.dismiss()
        } catch {}
        if (once) win.off('dialog', handler)
      }
      win.on('dialog', handler)
      return ok({ installed: true, action, once })
    },
  },

  get_text: {
    description:
      'Read the text content of an element matching a selector. Uses Playwright locators so it accepts the full selector engine (CSS, text=, role=, :has-text(), etc). If multiple elements match, returns the first. Does not wait — pair with wait_for_selector if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        trim: { type: 'boolean', description: 'Default true.' },
      },
      required: ['selector'],
    },
    handler: async ({ selector, trim = true }) => {
      requireApp()
      const loc = win.locator(selector)
      const count = await loc.count()
      if (count === 0) return ok({ exists: false, text: null })
      const raw = (await loc.first().textContent()) || ''
      return ok({ exists: true, text: trim ? raw.trim() : raw })
    },
  },

  eval_renderer: {
    description:
      'Evaluate JavaScript in the renderer (page) context. Pass a FUNCTION BODY — use `return` to yield a value. Example: `return document.title`. Supports async/await. Same contract as eval_main. Pass an arbitrary JSON-serializable `arg` to be available as the `arg` variable inside the body.',
    inputSchema: {
      type: 'object',
      properties: {
        js: {
          type: 'string',
          description:
            'Function body. Use `return` to yield a value. `arg` is available as a local.',
        },
        arg: ARG_SCHEMA,
      },
      required: ['js'],
    },
    handler: async ({ js, arg }) => {
      requireApp()
      const userArg = coerceArg(arg)
      const value = await win.evaluate(
        async ({ body, userArg }) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function('arg', `return (async () => { ${body} })()`)
          return await fn(userArg)
        },
        { body: js, userArg }
      )
      return ok({ value })
    },
  },

  eval_main: {
    description:
      'Evaluate JavaScript in the Electron main process. Pass a FUNCTION BODY — use `return` to yield a value. The body receives `electron` (the full Electron module) and `arg` (your JSON-serializable payload). Supports async/await. Use this to invoke IPC handlers, read paths, or drive windows the renderer cannot reach.',
    inputSchema: {
      type: 'object',
      properties: {
        js: {
          type: 'string',
          description:
            'Function body. Use `return` to yield a value. `electron` and `arg` are available as locals.',
        },
        arg: ARG_SCHEMA,
      },
      required: ['js'],
    },
    handler: async ({ js, arg }) => {
      requireApp()
      const userArg = coerceArg(arg)
      const value = await app.evaluate(
        async (electronApi, { body, userArg }) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function(
            'electron',
            'arg',
            `return (async () => { ${body} })()`
          )
          return await fn(electronApi, userArg)
        },
        { body: js, userArg }
      )
      return ok({ value })
    },
  },

  console_logs: {
    description:
      'Return recent console messages captured since the app started. Includes renderer console (log/info/warn/error/debug) and main-process stdout/stderr. Pass `clear: true` to drain the buffer after reading.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return. Default 200.' },
        source: {
          type: 'string',
          enum: ['renderer', 'main', 'all'],
          description: 'Filter by source. Default all.',
        },
        type: {
          type: 'string',
          description:
            'Filter by message type (e.g. "error", "warn", "log", "stderr"). Default all.',
        },
        clear: { type: 'boolean', description: 'If true, drain the buffer after reading.' },
      },
    },
    handler: async ({ limit = 200, source = 'all', type, clear = false }) => {
      requireApp()
      let entries = consoleBuffer
      if (source !== 'all') entries = entries.filter((e) => e.source === source)
      if (type) entries = entries.filter((e) => e.type === type)
      const sliced = entries.slice(-limit)
      if (clear) consoleBuffer = []
      return ok({ entries: sliced, total: entries.length })
    },
  },

  drop_file: {
    description:
      'Simulate dropping a file onto a target element by dispatching synthetic drag/drop events with a DataTransfer containing the file contents. Works for apps that read File via web APIs (FileReader, File.text, etc.). Does NOT populate file.path — apps that rely on webUtils.getPathForFile() or legacy file.path must use eval_main to invoke their IPC directly.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to a local file.' },
        selector: {
          type: 'string',
          description:
            'CSS selector of the drop target. Defaults to document.body.',
        },
        mimeType: {
          type: 'string',
          description: 'MIME type for the synthesized File object. Default text/plain.',
        },
      },
      required: ['filePath'],
    },
    handler: async ({ filePath, selector = 'body', mimeType = 'text/plain' }) => {
      requireApp()
      if (!path.isAbsolute(filePath)) {
        return err(`filePath must be absolute. Got: ${filePath}`)
      }
      if (!existsSync(filePath)) {
        return err(`File not found: ${filePath}`)
      }
      const contents = readFileSync(filePath).toString('base64')
      const name = path.basename(filePath)
      const delivered = await win.evaluate(
        async ({ selector, b64, name, mimeType }) => {
          const target = document.querySelector(selector)
          if (!target) return { ok: false, error: `No element matches selector: ${selector}` }
          const bin = atob(b64)
          const bytes = new Uint8Array(bin.length)
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
          const file = new File([bytes], name, { type: mimeType })
          const dt = new DataTransfer()
          dt.items.add(file)
          const rect = target.getBoundingClientRect()
          const cx = rect.x + rect.width / 2
          const cy = rect.y + rect.height / 2
          const common = {
            bubbles: true,
            cancelable: true,
            clientX: cx,
            clientY: cy,
            dataTransfer: dt,
          }
          target.dispatchEvent(new DragEvent('dragenter', common))
          target.dispatchEvent(new DragEvent('dragover', common))
          target.dispatchEvent(new DragEvent('drop', common))
          return { ok: true, targetTag: target.tagName, name }
        },
        { selector, b64: contents, name, mimeType }
      )
      if (!delivered?.ok) return err(delivered?.error || 'drop_file failed')
      return ok(delivered)
    },
  },
}

// ---- MCP wiring --------------------------------------------------------

const server = new Server(
  { name: 'electron-driver', version: '0.3.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const tool = tools[name]
  if (!tool) return err(`Unknown tool: ${name}`, 'UNKNOWN_TOOL')
  log('call', { tool: name, args })
  try {
    const result = await tool.handler(args || {})
    log('result', { tool: name, ok: !result.isError })
    return result
  } catch (e) {
    const rewritten = rewriteErrorForTool(e, name)
    const code = e?.code || (/^timeout/i.test(rewritten) ? 'TIMEOUT' : 'ERROR')
    log('error', { tool: name, error: rewritten, code })
    return err(rewritten, code)
  }
})

// Cleanup on shutdown so we never leave orphaned Electron processes.
async function cleanup() {
  if (app) {
    try {
      await app.close()
    } catch {}
  }
  process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('exit', () => {
  if (app) {
    try {
      app.close()
    } catch {}
  }
})

// ---- Boot --------------------------------------------------------------

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('electron-driver MCP server v0.3.0 ready\n')
