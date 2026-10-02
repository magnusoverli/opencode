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
    ["import { runtimeFetch } from '@/lib/runtime-fetch';", "import { runtimeFetch } from '@/lib/runtime-fetch';\nimport { createHaEditorLsp } from '@/lib/ha-editor-lsp/editor';"],
    ['    const language = staticLanguageExtension ?? dynamicLanguageExtension;',
      '    if (canEdit) extensions.push(createHaEditorLsp(selectedFile.path, runtimeFetch));\n    const language = staticLanguageExtension ?? dynamicLanguageExtension;'],
    ['}, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize, pinPreviewOnEditExtension, fileEditorKeymap]);',
      '}, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize, pinPreviewOnEditExtension, fileEditorKeymap, canEdit, runtimeKey]);'],
  ]);
  stage('packages/web/server/lib/opencode/bootstrap-runtime.js', [
    ['export const createBootstrapRuntime = (dependencies) => {',
      "import { registerEditorLspRoutes } from './ha-editor-lsp-routes.mjs';\n\nexport const createBootstrapRuntime = (dependencies) => {"],
    ['    registerTtsRoutes(app, { sayTTSCapability });',
      '    registerEditorLspRoutes(app, { express });\n\n    registerTtsRoutes(app, { sayTTSCapability });'],
  ]);
  // Assert the mount remains behind the existing auth registration.
  const backend = changes[1][1];
  if (backend.indexOf('    registerAuthAndAccessRoutes(app, {') < 0
      || backend.indexOf('    registerAuthAndAccessRoutes(app, {') > backend.indexOf('    registerEditorLspRoutes(app, {')) {
    throw new Error('Editor LSP auth mount changed');
  }
  for (const file of ['editor.ts', 'editor-core.mjs', 'editor-core.d.mts']) {
    changes.push([path.join(root, 'packages/ui/src/lib/ha-editor-lsp', file), fs.readFileSync(path.join(support, file), 'utf8')]);
  }
  changes.push([path.join(root, 'packages/web/server/lib/opencode/ha-editor-lsp-routes.mjs'), fs.readFileSync(path.join(support, 'routes.mjs'), 'utf8')]);
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
