const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const WASM_FILE = "ghostty-vt-fixture_123.wasm";
const WASM_BYTES = Buffer.from("0061736d01000000", "hex");
const RUNTIME_SOURCE = 'const base = new URL(baseUrl);\nconst url = new URL(`${base.origin}${base.pathname.replace(/\\/+$/, \'\')}${normalizedPath}`);';
const MAIN_JS = [
  'function runtime(s,b){try{return new URL(s,`${b.replace(/\\/+$/,"")}/`).toString()}catch{return s}}',
  'const isApi=p=>p.startsWith("/api/")||p==="/api"||p.startsWith("/auth/")||p==="/auth"||p==="/health";',
  'if("serviceWorker"in navigator){navigator.serviceWorker.register("/sw.js")}',
  'const image="/assets/image.svg";const unrelated=new URL("./other.wasm",import.meta.url);',
].join("\n");

function registerIngressPatchTests(addonRoot) {
  const patch = path.join(addonRoot, "rootfs/opt/openchamber/patch-ingress.js");

  function fixture(t, terminalJs = `export const wasm=new URL("/assets/${WASM_FILE}",import.meta.url);`) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-ingress-patch-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const web = path.join(root, "packages/web");
    const assets = path.join(web, "dist/assets");
    const ui = path.join(root, "packages/ui/src/lib");
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(ui, { recursive: true });
    fs.writeFileSync(path.join(ui, "runtime-url.ts"), RUNTIME_SOURCE);
    fs.writeFileSync(path.join(web, "dist/index.html"), '<html><head><script>const baseUrl = location.origin;</script><script type="module" src="/assets/main.js"></script></head></html>');
    fs.writeFileSync(path.join(assets, "main.js"), MAIN_JS);
    fs.writeFileSync(path.join(assets, "surface-fixture.js"), terminalJs);
    fs.writeFileSync(path.join(assets, "style.css"), '@font-face{src:url("/assets/font.woff2")}');
    fs.writeFileSync(path.join(assets, WASM_FILE), WASM_BYTES);
    return {
      web,
      assets,
      run: () => spawnSync(process.execPath, [patch, web], { encoding: "utf8" }),
      read: file => fs.readFileSync(path.join(assets, file), "utf8"),
    };
  }

  describe("OpenChamber ingress build patch: terminal WebAssembly (#194)", () => {
    for (const [label, expression] of [
      ["root-relative", `new URL("/assets/${WASM_FILE}",import.meta.url)`],
      ["previously stripped", `new URL("assets/${WASM_FILE}",import.meta.url)`],
      ["single-quoted", `new URL('/assets/${WASM_FILE}',import.meta.url)`],
      ["whitespace and backticks", `new URL( \`/assets/${WASM_FILE}\` , import.meta.url )`],
    ]) {
      it(`preserves module-relative loading for a ${label} terminal URL`, t => {
        const f = fixture(t, `export const wasm=${expression};`);
        const result = f.run();
        assert.equal(result.status, 0, result.stderr);
        const patched = f.read("surface-fixture.js");
        assert.match(patched, /new URL\((["'`])\.\/ghostty-vt-fixture_123\.wasm\1,import\.meta\.url\)/);
        for (const prefix of ["", "/api/hassio_ingress/fixture", "/custom/mount"]) {
          const moduleUrl = `https://ha.example${prefix}/assets/surface-fixture.js`;
          assert.equal(new URL(`./${WASM_FILE}`, moduleUrl).pathname, `${prefix}/assets/${WASM_FILE}`);
        }
        assert.deepEqual(fs.readFileSync(path.join(f.assets, WASM_FILE)), WASM_BYTES);
      });
    }

    it("retains document-relative assets, CSS font URLs and unrelated module URLs", t => {
      const f = fixture(t);
      const result = f.run();
      assert.equal(result.status, 0, result.stderr);
      assert.ok(f.read("main.js").includes('const image="assets/image.svg"'));
      assert.ok(f.read("main.js").includes('new URL("./other.wasm",import.meta.url)'));
      assert.ok(f.read("style.css").includes('url("font.woff2")'));
    });

    it("fails the build if the terminal URL shape changes", t => {
      const f = fixture(t, `export const wasm=loadWasm("/assets/${WASM_FILE}");`);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /terminal WebAssembly URL expected 1 match, found 0/);
    });

    it("fails the build for duplicate terminal references in one chunk", t => {
      const expression = `new URL("/assets/${WASM_FILE}",import.meta.url)`;
      const f = fixture(t, `const first=${expression},second=${expression};`);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /terminal WebAssembly URL expected 1 match, found 2/);
    });

    it("fails the build for duplicate terminal references across chunks", t => {
      const f = fixture(t);
      fs.writeFileSync(path.join(f.assets, "second.js"), `new URL("/assets/${WASM_FILE}",import.meta.url)`);
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /terminal WebAssembly URL expected 1 match, found 2/);
    });

    it("fails the build if the referenced terminal asset is missing", t => {
      const f = fixture(t);
      fs.unlinkSync(path.join(f.assets, WASM_FILE));
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /terminal WebAssembly asset not found: ghostty-vt-fixture_123\.wasm/);
    });

    it("keeps the build patch identical across channels", () => {
      const root = path.join(__dirname, "..");
      const relative = "rootfs/opt/openchamber/patch-ingress.js";
      assert.equal(fs.readFileSync(path.join(root, "ha_opencode", relative), "utf8"), fs.readFileSync(path.join(root, "ha_opencode_beta", relative), "utf8"));
    });
  });
}

module.exports = { registerIngressPatchTests };
