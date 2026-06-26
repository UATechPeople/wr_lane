import tailwind from "bun-plugin-tailwind";

// Production build of the React UI: Bun bundles public/index.html (+ tsx + css) into
// dist/ with the Tailwind plugin running content-scan, so utility classes are generated.
// (The dev fullstack server bundles at runtime, but that path doesn't run the plugin in
// production — so we pre-build here and serve dist/ statically.)
const result = await Bun.build({
  entrypoints: ["public/index.html"],
  outdir: "dist",
  minify: true,
  publicPath: "/",
  naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`[build-web] ${result.outputs.length} files -> dist/`);
