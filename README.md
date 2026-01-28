# Random Matrix (Obsidian Plugin)

Random Matrix is an Obsidian plugin that helps you pick the next note from a matrix of study notes based on rank, status, and recency. It supports weighted selection, status updates, and optional metadata fields to keep review sessions balanced.

## Getting Started

### Prerequisites
- Node.js (for local builds)
- pnpm (recommended)

### Install Dependencies
```sh
pnpm install
```

### Development (watch mode)
```sh
pnpm run dev
```
This rebuilds `main.js` whenever `main.ts` changes.

### Production Build
```sh
pnpm run build
```
This bundles the plugin to `main.js` using esbuild.

## Installing with BRAT (recommended)
1. Install the BRAT community plugin in Obsidian.
2. Run the command `BRAT: Add a beta plugin for testing`.
3. Paste this repository URL when prompted:
   `https://github.com/shaunakg/obsidian-random-matrix`
4. Enable the plugin in Settings → Community plugins.

## Installing in Obsidian (manual)
1. Create a folder under your vault: `.obsidian/plugins/obsidian-random-matrix`.
2. Copy `manifest.json`, `main.js`, and `styles.css` into that folder.
3. Reload Obsidian and enable the plugin in Settings → Community plugins.

## Project Layout
- `main.ts`: TypeScript source for the plugin.
- `main.js`: Generated bundle (do not edit directly).
- `styles.css`: Plugin UI styles.
- `manifest.json`: Plugin metadata (id, name, version).
- `esbuild.config.mjs`: Build configuration.
- `data.json` and `Year 4C/`: sample or working data used during development.

## Notes
- The plugin expects frontmatter fields for rank/status (configurable in settings).
- Use Obsidian’s developer console to debug if the picker UI does not appear.
