const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const script = path.join(__dirname, "../rootfs/opt/openchamber/patch-app-updates.cjs");
const { key, messages, patchAppUpdates } = require(script);
// Captured independently from the pinned upstream dictionaries, not the patcher.
const upstream = require("./fixtures/openchamber-update-notices.json");

function fixture(t, newline = "\n") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openchamber-app-updates-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "packages/ui/src/lib/i18n/messages");
  fs.mkdirSync(directory, { recursive: true });
  const originals = new Map();
  for (const [locale, before] of Object.entries(upstream.messages)) {
    // The pinned preview uses both key/value quoting styles.
    const quote = ["uk", "es", "pt-BR"].includes(locale) ? '"' : "'";
    const source = [
      "const dictionary = {",
      "  'unrelated': 'Keep this text and formatting.',",
      `  ${quote}${key}${quote}: ${quote}${before}${quote},`,
      "};",
      "export default dictionary;",
      "",
    ].join(newline);
    const target = path.join(directory, `${locale}.ts`);
    fs.writeFileSync(target, source);
    originals.set(target, source);
  }
  return { root, directory, originals };
}

function assertUnchanged(originals) {
  for (const [file, source] of originals) assert.equal(fs.readFileSync(file, "utf8"), source);
}

for (const newline of ["\n", "\r\n"]) {
  test(`patches only the notice value in all 13 locales (${JSON.stringify(newline)})`, (t) => {
    const { root, originals } = fixture(t, newline);
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(upstream.messages).sort());
    assert.equal(patchAppUpdates(root), 13);
    for (const [target, original] of originals) {
      const locale = path.basename(target, ".ts");
      const before = upstream.messages[locale];
      const after = messages[locale][1];
      const quote = ["uk", "es", "pt-BR"].includes(locale) ? '"' : "'";
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source, original.replace(`${quote}${before}${quote}`, JSON.stringify(after)));
      assert.equal((after.match(/\{version\}/g) || []).length, 1);
      assert.match(after, /Home Assistant Supervisor/);
      assert.match(after, /OpenCode/);
      assert.match(after, /OpenChamber/);
      assert.doesNotMatch(after, /npm |curl |openchamber update|opencode upgrade/);
    }
  });
}

test("fails before any writes when a late locale has changed upstream", (t) => {
  const { root, directory, originals } = fixture(t);
  const target = path.join(directory, "zh-TW.ts");
  const changed = originals.get(target).replace(messages["zh-TW"][0], "Changed upstream guidance.");
  fs.writeFileSync(target, changed);
  originals.set(target, changed);
  assert.throws(() => patchAppUpdates(root), /Unexpected preview update notice: zh-TW/);
  assertUnchanged(originals);
});

test("rejects duplicate keys before writing any locale", (t) => {
  const { root, directory, originals } = fixture(t);
  const target = path.join(directory, "fr.ts");
  const changed = originals.get(target) + `'${key}': '${messages.fr[0]}',\n`;
  fs.writeFileSync(target, changed);
  originals.set(target, changed);
  assert.throws(() => patchAppUpdates(root), /Unexpected preview update notice: fr/);
  assertUnchanged(originals);
});

test("rejects a missing key before writing any locale", (t) => {
  const { root, directory, originals } = fixture(t);
  const target = path.join(directory, "pl.ts");
  const changed = originals.get(target).replace(key, "different.key");
  fs.writeFileSync(target, changed);
  originals.set(target, changed);
  assert.throws(() => patchAppUpdates(root), /Unexpected preview update notice: pl/);
  assertUnchanged(originals);
});

for (const duplicate of [`'${key}':'Another value',`, `'${key}': 'Another value', // comment`]) {
  test(`rejects a differently formatted duplicate: ${duplicate}`, (t) => {
    const { root, directory, originals } = fixture(t);
    const target = path.join(directory, "en.ts");
    const changed = originals.get(target) + duplicate + "\n";
    fs.writeFileSync(target, changed);
    originals.set(target, changed);
    assert.throws(() => patchAppUpdates(root), /Unexpected preview update notice: en/);
    assertUnchanged(originals);
  });
}

test("rejects a missing locale before writing any locale", (t) => {
  const { root, directory, originals } = fixture(t);
  const target = path.join(directory, "ja.ts");
  fs.unlinkSync(target);
  originals.delete(target);
  assert.throws(() => patchAppUpdates(root), /Missing preview update-notice locale/);
  assertUnchanged(originals);
});

test("rejects new locale overrides rather than retaining installer guidance", (t) => {
  const { root, directory, originals } = fixture(t);
  const target = path.join(directory, "new-locale.ts");
  const changed = `'${key}': 'Unreviewed installer guidance',\n`;
  fs.writeFileSync(target, changed);
  originals.set(target, changed);
  assert.throws(() => patchAppUpdates(root), /Unreviewed update-notice locale/);
  assertUnchanged(originals);
});

test("refuses a second patch and leaves the already-patched files intact", (t) => {
  const { root, originals } = fixture(t);
  patchAppUpdates(root);
  const patched = new Map([...originals.keys()].map((file) => [file, fs.readFileSync(file, "utf8")]));
  assert.throws(() => patchAppUpdates(root), /Unexpected preview update notice/);
  assertUnchanged(patched);
});

test("CLI requires an explicit source checkout", () => {
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: patch-app-updates.cjs/);
});

test("Docker applies the notice source patch before building the frontend", () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, "../Dockerfile"), "utf8");
  assert.equal(/^ARG OPENCHAMBER_REVISION=(.+)$/m.exec(dockerfile)?.[1]?.trim(), upstream.revision,
    "Refresh the independent notice fixture when changing the preview pin");
  const patch = dockerfile.indexOf("RUN node /tmp/patch-app-updates.cjs /opt/openchamber-preview");
  assert.ok(patch > dockerfile.indexOf('git checkout --detach FETCH_HEAD'));
  assert.ok(patch < dockerfile.indexOf("bun run --cwd packages/web build"));
  assert.match(dockerfile, /COPY rootfs\/opt\/openchamber\/patch-app-updates.cjs \/tmp\/patch-app-updates.cjs/);
});
