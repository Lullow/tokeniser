import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const shared = { bundle: true, sourcemap: !production, minify: production, logLevel: "info", outdir: "dist" };

const contexts = await Promise.all([
  esbuild.context({
    ...shared,
    entryPoints: { extension: "src/extension.ts", collector: "src/collector/main.ts" },
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["vscode"],
  }),
  esbuild.context({
    ...shared,
    entryPoints: [
      { in: "src/view/webview/main.ts", out: "view" },
      { in: "src/view/webview/view.css", out: "view" },
    ],
    format: "iife",
    platform: "browser",
    target: "es2022",
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
