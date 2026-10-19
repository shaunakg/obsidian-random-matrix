# Repository Guidelines

## Project Structure & Module Organization
- `main.ts` is the TypeScript source for the Obsidian plugin (index, panel view, settings, commands); `main.js` is the bundled output (do not edit by hand).
- `src/engine.ts` holds the pure picking logic (rank plan, weights, drawing choices). Keep it free of `obsidian` imports so it can be exercised from Node.
- `styles.css` contains plugin UI styles, and `manifest.json` defines the plugin metadata (id, version, name).
- `esbuild.config.mjs` and `tsconfig.json` control bundling and TypeScript settings.
- `node_modules/` and `pnpm-lock.yaml` indicate the dependency manager and lockfile.

## Build, Test, and Development Commands
- `pnpm install` — installs dependencies using the lockfile in this repo.
- `pnpm run build` — bundles `main.ts` into `main.js` via esbuild for production use.
- `pnpm run dev` — runs the esbuild watcher to rebuild on changes.

## Coding Style & Naming Conventions
- TypeScript is configured in strict mode (see `tsconfig.json`); keep types explicit and avoid `any`.
- Match existing style: 2-space indentation, semicolons, and double-quoted strings.
- Naming conventions in code: `PascalCase` for classes/interfaces, `camelCase` for variables/settings fields, and `UPPER_SNAKE_CASE` for constants (e.g., `VIEW_TYPE`).

## Testing Guidelines
- No automated test framework is configured in this repository.
- Manual verification: run `pnpm run build` or `pnpm run dev`, load the plugin in Obsidian, and exercise choose/shuffle/finish/snooze flows while checking the console for errors.
- The engine can be checked without Obsidian: bundle `src/engine.ts` with esbuild (`--format=cjs --platform=node`) and drive it from a Node script.

## Commit & Pull Request Guidelines
- Short, imperative commit summaries (e.g., “Keep completed status value configurable”).
- For PRs, include a clear description of behavior changes, steps to verify, and screenshots if UI behavior changes.

## Configuration & Release Notes
- Keep `manifest.json` version and plugin name aligned with releases and documentation.
- Treat `main.js` as generated output; regenerate with `pnpm run build` rather than editing it directly.
- Pushing to `main` with a new `manifest.json` version publishes a GitHub release (and BRAT updates). Persisted data is versioned (`version: 2`); keep `loadPluginData` able to migrate older shapes.
