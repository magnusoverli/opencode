import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { patchEditorLsp } = createRequire(import.meta.url)('../rootfs/opt/openchamber/patch-editor-lsp.cjs');
const view = 'packages/ui/src/components/views/FilesView.tsx';
const front = 'packages/ui/src/components/views/files/view/useFileEditorExtensions.tsx';
const back = 'packages/web/server/lib/server-frame/bootstrap-runtime.ts';
const frontend = `import React from 'react';
function useFileEditorExtensions({ editor,
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'fileEditorKeymap'
  scope: Pick<ReturnType<typeof useFileScope>, 'currentDirectory' | 'panelRoot' | 'root'>
    const language = staticLanguageExtension ?? dynamicLanguageExtension;
}, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize, pinPreviewOnEditExtension, fileEditorKeymap, t, importLinksExtension, codeSelectionComment.extension]);`;
const backend = `export const createBootstrapRuntime = (dependencies: BootstrapDependencies) => {
    const { requireApiAuth } = registerAuthAndAccessRoutes(app, {
    });
    registerTtsRoutes(app, { sayTTSCapability });
};`;
async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'editor-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries({ [view]: "useFileEditorExtensions({ editor,", [front]: frontend, [back]: backend, ...files })) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test('source patch installs both editor views through shared extensions and mounts after auth', async (t) => {
  const root = await fixture(t);
  patchEditorLsp(root);
  const ui = await readFile(join(root, front), 'utf8');
  const server = await readFile(join(root, back), 'utf8');
  assert.match(ui, /if \(canEdit && selectedFile\) extensions.push\(createHaEditorLsp\(selectedFile.path, runtimeFetch\)\)/);
  assert.match(ui, /fileEditorKeymap, t, importLinksExtension, codeSelectionComment.extension, canEdit, scope.runtimeKey\]/);
  assert.ok(server.indexOf('    const { requireApiAuth } = registerAuthAndAccessRoutes') < server.indexOf('    registerEditorLspRoutes'));
  const routes = await readFile(join(root, 'packages/web/server/lib/server-frame/ha-editor-lsp-routes.mjs'), 'utf8');
  assert.match(routes, /loadClient = \(\) => import\("\/opt\/opencode-v2-homeassistant\/lsp-client.js"\)/);
  assert.doesNotMatch(routes, /@opencode\/plugin/);
  for (const file of ['editor.ts', 'editor-core.mjs', 'editor-core.d.mts']) await access(join(root, 'packages/ui/src/lib/ha-editor-lsp', file));
  assert.throws(() => patchEditorLsp(root), /Unexpected pinned/);
});

test('any missing or duplicate source anchor rejects all writes, including support installation', async (t) => {
  for (const files of [{ [back]: backend.replace('registerTtsRoutes', 'changedTtsRoutes') },
    { [front]: frontend + frontend }, { [back]: backend.replace('registerAuthAndAccessRoutes', 'changedAuth') }]) {
    const root = await fixture(t, files);
    const before = await readFile(join(root, front), 'utf8');
    assert.throws(() => patchEditorLsp(root), /Unexpected pinned|auth mount/);
    assert.equal(await readFile(join(root, front), 'utf8'), before);
    await assert.rejects(access(join(root, 'packages/ui/src/lib/ha-editor-lsp')));
  }
});

test('missing support input rejects before modifying either upstream source file', async (t) => {
  const root = await fixture(t);
  assert.throws(() => patchEditorLsp(root, join(root, 'missing')), /ENOENT/);
  assert.equal(await readFile(join(root, front), 'utf8'), frontend);
  assert.equal(await readFile(join(root, back), 'utf8'), backend);
});

test('Docker patches editor source before compiling and ships the shared client', async () => {
  const docker = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const patch = docker.indexOf('RUN node /tmp/patch-editor-lsp.cjs /opt/openchamber-preview');
  const build = docker.indexOf('bun run --cwd packages/web build');
  assert.ok(patch >= 0 && build > patch);
  assert.ok(docker.indexOf('COPY rootfs/opt/openchamber/editor-lsp /tmp/editor-lsp') < patch);
  assert.match(docker, /^COPY rootfs \/$/m);
  await access(new URL('../rootfs/opt/opencode-v2-homeassistant/lsp-client.js', import.meta.url));
});
