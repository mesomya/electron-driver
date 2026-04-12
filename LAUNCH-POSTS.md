# Launch posts — copy-paste ready

## Show HN

**Title:** Show HN: electron-driver – MCP server that lets AI agents drive Electron apps

**Body:**

I'm building an Electron app (a Markdown viewer) and got tired of being the
middleman between the AI coding agent and the running app. The agent could
write code, but it couldn't see or interact with the result — I had to
manually test every change and report back.

So I built electron-driver: an MCP server that gives AI agents real control
over Electron apps. It uses Playwright's _electron API under the hood and
exposes 39 tools — click, type, drag, screenshot, evaluate JS in the renderer
or main process, read console logs, handle multi-window apps, capture
accessibility snapshots, and more.

The key design choice: a `snapshot` tool that returns a numbered list of
visible elements (like Playwright MCP's browser_snapshot). The agent calls
snapshot once, sees what's on screen as text, then interacts by ref number
instead of guessing CSS selectors. This cuts the typical interaction from
5 round-trips down to 2.

It works with any Electron app — React, Vue, Svelte, vanilla — as long as
you can point it at your compiled main-process entry.

GitHub: https://github.com/mesomya/electron-driver
npm: `npm install electron-driver`

Happy to answer questions about the MCP protocol, Playwright's _electron
API, or the design decisions.

---

## r/ClaudeAI

**Title:** I built an MCP server so Claude can actually drive Electron apps — no more being the middleman

**Body:**

I'm vibe-coding an Electron app with Claude Code. The problem: Claude could
write code all day, but it was flying blind on every visual change. I had to
run the app, click around, take screenshots, paste them back. I was the
subagent.

So I built `electron-driver` — an MCP server that lets Claude (or any
MCP-compatible agent) launch, drive, and visually verify Electron apps
directly. 39 tools: click, type, drag, screenshot, eval JS in renderer and
main process, console logs, accessibility snapshots, multi-window support.

The workflow now:
1. Claude implements a feature
2. Claude calls `start_app` → `snapshot` → sees the page as numbered refs
3. Claude clicks, types, drags by ref number
4. Claude screenshots to verify visually
5. Claude reports back to me only when it's confident everything works

It works with ANY Electron app, not just mine. React, Vue, Svelte, vanilla.

npm: `npm install electron-driver`
GitHub: https://github.com/mesomya/electron-driver

Would love feedback from anyone else doing vibe-coded desktop apps.

---

## r/electronjs

**Title:** Testing Electron apps with AI agents — I built a Playwright-backed MCP server for it

**Body:**

If you're using AI coding agents (Claude Code, Cursor, etc.) to build Electron
apps, you've probably hit the same wall I did: the agent can write code but
can't see or interact with the running app.

`electron-driver` is an MCP server that exposes Playwright's `_electron` API
as agent-callable tools. It launches your built app, gives the agent a
snapshot of visible elements, and lets it click/type/drag/screenshot/eval
just like a real user.

39 tools, works with any Electron app. Key features:
- `snapshot` returns a numbered list of interactive elements — agents interact by ref number, no selector guessing
- `eval_renderer` and `eval_main` for JS execution in either process
- `drag` with React fiber fallback for pointer-event splitters
- `console_logs` captures renderer + main process output
- `accessibility_snapshot` for ARIA tree audits
- `windows_list` + `switch_window` for multi-window apps
- `dialog_handler` for JS alert/confirm/prompt
- Auto-resolves the Electron binary from your project's node_modules

npm: `npm install electron-driver`
GitHub: https://github.com/mesomya/electron-driver

Built on Playwright's experimental _electron API. MIT licensed. Feedback and
PRs welcome.

---

## X / Twitter thread

**Tweet 1:**
I built an MCP server that lets AI agents drive Electron apps.

Click, type, drag, screenshot, eval JS, read console logs — 39 tools, works
with any Electron app.

[attach demo video]

**Tweet 2:**
The problem: I'm vibe-coding an Electron app with Claude. It writes great
code but can't see the result. I was the middleman — running the app, clicking
around, reporting back.

Now Claude drives the app itself via electron-driver.

**Tweet 3:**
Key design: a `snapshot` tool returns a numbered list of visible elements.
The agent calls snapshot, sees what's on screen as text, then interacts by
ref number.

2 tool calls instead of 5. No CSS selector guessing.

**Tweet 4:**
Works with React, Vue, Svelte, vanilla — any Electron app.

npm install electron-driver
https://github.com/mesomya/electron-driver

MIT licensed. Built on Playwright's _electron API.

@AnthropicAI @anthropaborations

---

## MCP servers list PR

Submit to: https://github.com/modelcontextprotocol/servers

Add under Community Servers:
```
| [electron-driver](https://github.com/mesomya/electron-driver) | Drive Electron desktop apps from AI agents — click, type, drag, screenshot, eval JS, and more. Built on Playwright. |
```
