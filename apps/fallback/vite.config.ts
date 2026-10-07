import { defineConfig, type Plugin } from "vite";

class NotASingleFile extends Error {
  override readonly name = "NotASingleFile";
}

// Inlines the one script chunk into the page, so the build is a single HTML file that opens from
// any static host, IPFS, or straight from disk. Fails the build if anything else would be emitted.
function singleFile(): Plugin {
  return {
    name: "vayle-single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const outputs = Object.values(bundle);
      const page = outputs.find((o) => o.type === "asset" && o.fileName === "index.html");
      const chunks = outputs.filter((o) => o.type === "chunk");
      const script = chunks[0];
      if (page?.type !== "asset" || chunks.length !== 1 || script === undefined) {
        throw new NotASingleFile(`expected index.html and one script, got ${outputs.length} files`);
      }
      const tag = new RegExp(
        `<script type="module" crossorigin src="[^"]*${script.fileName}"></script>`,
      );
      const html = String(page.source);
      if (!tag.test(html)) throw new NotASingleFile(`index.html doesn't load ${script.fileName}`);
      const leftover = /__VITE_[A-Z_]+__/.exec(script.code);
      if (leftover !== null) throw new NotASingleFile(`${leftover[0]} was left in the bundle`);
      // A literal "</script" inside the bundle would end the inline script early.
      const code = script.code.replaceAll("</script", "<\\/script");
      page.source = html.replace(tag, () => `<script type="module">${code}</script>`);
      Reflect.deleteProperty(bundle, script.fileName);
      if (Object.keys(bundle).length !== 1) {
        throw new NotASingleFile(`left ${Object.keys(bundle).join(", ")} beside index.html`);
      }
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [singleFile()],
  // With code splitting off, dynamic imports are inlined but Vite leaves their preload
  // placeholder in place, and viem dynamically imports on every reverted call. No chunks means
  // nothing to preload.
  define: { __VITE_PRELOAD__: "void 0" },
  build: {
    target: "es2022",
    modulePreload: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
