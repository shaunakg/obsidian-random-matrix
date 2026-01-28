# Repository Guidelines

## Project Structure & Module Organization
- `main.ts` is the TypeScript source for the Obsidian plugin; `main.js` is the bundled output (do not edit by hand).
- `styles.css` contains plugin UI styles, and `manifest.json` defines the plugin metadata (id, version, name).
- `esbuild.config.mjs` and `tsconfig.json` control bundling and TypeScript settings.
- `data.json` and the `Year 4C/` folder appear to be sample/runtime data used for development; update only when intentionally changing fixtures.
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
- Manual verification: run `pnpm run build` or `pnpm run dev`, load the plugin in Obsidian, and exercise pick/status flows while checking the console for errors.

## Commit & Pull Request Guidelines
- This checkout does not include a `.git` history, so commit conventions cannot be inferred.
- Suggested default: short, imperative commit summaries (e.g., “Add status weight setting”).
- For PRs, include a clear description of behavior changes, steps to verify, and screenshots if UI behavior changes.

## Configuration & Release Notes
- Keep `manifest.json` version and plugin name aligned with releases and documentation.
- Treat `main.js` as generated output; regenerate with `pnpm run build` rather than editing it directly.
