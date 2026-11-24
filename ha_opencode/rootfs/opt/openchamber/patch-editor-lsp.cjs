// Apply to the pinned repository root BEFORE building packages/ui. Validate all
// exact anchors and support inputs before writing anything (fail on source drift).
const fs = require('node:fs');
const path = require('node:path');

function patchEditorLsp(root, support = path.join(__dirname, 'editor-lsp')) {
  const changes = [];
  function stage(relative, edits) {
    const target = path.join(root, relative);
    let source = fs.readFileSync(target, 'utf8');
    for (const [before, after] of edits) {
      if (source.split(before).length !== 2) throw new Error(`Unexpected pinned editor source: ${relative}`);
      source = source.replace(before, after);
    }
    changes.push([target, source]);
  }
  stage('packages/ui/src/components/views/FilesView.tsx', [
    ['useFileEditorExtensions({ editor,', 'useFileEditorExtensions({ canEdit: fileKinds.canEdit, editor,'],
  ]);
  stage('packages/ui/src/components/views/files/view/useFileEditorExtensions.tsx', [
    ["import React from 'react';", "import React from 'react';\nimport { runtimeFetch } from '@/lib/runtime-fetch';\nimport { createHaEditorLsp } from '@/lib/ha-editor-lsp/editor';"],
    ['function useFileEditorExtensions({ editor,', 'function useFileEditorExtensions({ canEdit, editor,'],
    ["  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'fileEditorKeymap'", "  canEdit: boolean;\n  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'fileEditorKeymap'"],
    ["'panelRoot' | 'root'>", "'panelRoot' | 'root' | 'runtimeKey'>"],
    ['    const language = staticLanguageExtension ?? dynamicLanguageExtension;',
      '    if (canEdit && selectedFile) extensions.push(createHaEditorLsp(selectedFile.path, runtimeFetch));\n    const language = staticLanguageExtension ?? dynamicLanguageExtension;'],
    ['importLinksExtension, codeSelectionComment.extension]);', 'importLinksExtension, codeSelectionComment.extension, canEdit, scope.runtimeKey]);'],
  ]);
  stage('packages/web/server/lib/server-frame/bootstrap-runtime.ts', [
    ['export const createBootstrapRuntime = (dependencies: BootstrapDependencies) => {',
      "import { registerEditorLspRoutes } from './ha-editor-lsp-routes.mjs';\n\nexport const createBootstrapRuntime = (dependencies: BootstrapDependencies) => {"],
    ['    registerTtsRoutes(app, { sayTTSCapability });',
      '    registerEditorLspRoutes(app, { express });\n\n    registerTtsRoutes(app, { sayTTSCapability });'],
  ]);
  // Assert the mount remains behind the existing auth registration.
  const backend = changes[2][1];
  if (backend.indexOf('const { requireApiAuth } = registerAuthAndAccessRoutes(app, {') < 0
      || backend.indexOf('const { requireApiAuth } = registerAuthAndAccessRoutes(app, {') > backend.indexOf('    registerEditorLspRoutes(app, {')) {
    throw new Error('Editor LSP auth mount changed');
  }
  for (const file of ['editor.ts', 'editor-core.mjs', 'editor-core.d.mts']) {
    changes.push([path.join(root, 'packages/ui/src/lib/ha-editor-lsp', file), fs.readFileSync(path.join(support, file), 'utf8')]);
  }
  changes.push([path.join(root, 'packages/web/server/lib/server-frame/ha-editor-lsp-routes.mjs'), fs.readFileSync(path.join(support, 'routes.mjs'), 'utf8')]);
  for (const [target, content] of changes) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

module.exports = { patchEditorLsp };
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: patch-editor-lsp.cjs <pinned-repository-root> [support-directory]');
  patchEditorLsp(process.argv[2], process.argv[3]);
  console.log('OpenChamber bounded HA YAML editor integration installed');
}
