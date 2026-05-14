# Contributing to electron-driver

Thanks for taking the time to contribute. This project is small and opinionated; the goal is to keep the tool surface tight and correctness high. Here's how to help without stepping on toes.

## Ways to contribute

- **Report a bug.** Open an issue with a minimal reproduction against a real Electron app. "My app's drag doesn't work" is hard to debug; "here's a 50-line Electron app that fails when I call `drag` like this" is actionable.
- **Suggest a tool.** If there's a common Electron-app testing operation the driver doesn't cover, open an issue with: what the operation is, which Playwright APIs it would wrap, and a concrete example call. Keep proposals scoped — one tool per issue.
- **Improve docs.** README clarifications, typo fixes, better examples all welcome via PR.
- **Fix a rough edge.** Error messages that could be clearer, schema hints that could be better, anything in the tracker tagged `good-first-issue`.

## What we don't take

- **Framework-specific tools.** No `drag_react`, `drag_vue`, `drag_svelte`. The driver stays framework-agnostic; the React fiber fallback inside `drag` is the one exception and is deliberately hidden behind generic behaviour.
- **Wrappers for "common test patterns."** `click_and_wait_for_selector` is not a tool. Callers compose primitives.
- **Anything Playwright already does well via a single API call.** If the user can call `locator.fill()` via `eval_renderer`, we don't need `super_fill`.

## Local development

Requires **Node 22 or later** (Node 20 is EOL; `engine-strict=true` in `.npmrc` enforces this).

```bash
git clone https://github.com/mesomya/electron-driver
cd electron-driver
npm install
node index.mjs
# Server boots on stdin/stdout as an MCP server.
```

To test against a real Electron app: register the local `index.mjs` in your MCP client config, start your Electron app build, then drive it via the tools.

## Code style

- Plain `.mjs`, no TypeScript build step.
- No transpiler, no bundler, no tests framework — intentional to keep the dependency surface tiny.
- Tools live in the `tools` object in `index.mjs`. Each has a `description`, `inputSchema`, and `handler`. Keep descriptions specific about inputs, outputs, and gotchas.
- Error messages include a stable `code` so callers can branch programmatically. See the `err()` helper.
- When in doubt about whether to add a feature, err on the side of not adding it. The tool surface is a contract.

## Testing changes

CI runs a boot smoke test on every push/PR across Node 22 and 24 on Ubuntu, Windows, and macOS (6 matrix runners). The test boots the server, verifies the ready banner appears on stderr, and confirms clean exit on stdin close. It also runs `npm audit` and Trivy secret scanning.

For manual validation of a change:

1. Booting the server: `node index.mjs`
2. Driving a real Electron app with a fresh change via an MCP client (Claude Code, Claude Desktop, Cursor)
3. Exercising every code path your change touched — both the happy path and the error path

Please include a short "test plan" in your PR description listing what you exercised manually.

## Submitting a PR

1. Fork, branch (`feat/your-thing` or `fix/your-thing`).
2. Commit with a clear message describing what and why, not how.
3. Update `CHANGELOG.md` under an "Unreleased" heading if your change is user-facing.
4. Open a PR against `main`. Describe: what changed, why, how you tested.
5. Be patient — reviews may take a few days.

## License

By contributing you agree your contribution is licensed under the MIT license, matching the rest of the project.
