import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const ctx = await esbuild.context({
  entryPoints: {
    extension: "src/extension.ts",
    collector: "src/collector/main.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
