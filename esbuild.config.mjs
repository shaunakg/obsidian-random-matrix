import esbuild from "esbuild";
import process from "process";

const isWatch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2018",
  platform: "browser",
  external: ["obsidian"],
  outfile: "main.js",
  sourcemap: "inline",
  treeShaking: true,
  logLevel: "info",
});

if (isWatch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
