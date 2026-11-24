// Real CodeMirror state/view tests in a simulated DOM. Set HA_EDITOR_TEST_DEPS
// to a directory with node_modules containing the pinned CodeMirror packages,
// typescript and jsdom. This is deliberately not claimed as browser acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

test('real CodeMirror unsaved-draft diagnostics, completion and lifecycle', { skip: !process.env.HA_EDITOR_TEST_DEPS }, async (t) => {
  const root = process.env.HA_EDITOR_TEST_DEPS;
  const require = createRequire(join(root, 'package.json'));
  const { JSDOM } = require('jsdom');
  const esm = (name) => import(pathToFileURL(join(dirname(require.resolve(name)), 'index.js')).href);
  const { EditorState, Compartment } = await esm('@codemirror/state');
  const { EditorView } = await esm('@codemirror/view');
  const { diagnosticCount } = await esm('@codemirror/lint');
  const { startCompletion, closeCompletion, currentCompletions, acceptCompletion } = await esm('@codemirror/autocomplete');
  const generated = await mkdtemp(join(root, 'editor-test-'));
  t.after(() => rm(generated, { recursive: true, force: true }));
  // Use the installed compiler CLI; TypeScript 7 no longer exports transpileModule.
  await copyFile(new URL('../rootfs/opt/openchamber/editor-lsp/editor.ts', import.meta.url), join(generated, 'editor.mts'));
  execFileSync(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
    '--noCheck', '--module', 'esnext', '--target', 'ES2022', join(generated, 'editor.mts')]);
  await copyFile(new URL('../rootfs/opt/openchamber/editor-lsp/editor-core.mjs', import.meta.url), join(generated, 'editor-core.mjs'));
  const { createHaEditorLsp } = await import(pathToFileURL(join(generated, 'editor.mjs')).href);
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const old = new Map();
  for (const name of ['window', 'document', 'Window', 'Node', 'HTMLElement', 'MutationObserver', 'DOMRect', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    old.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    const value = ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(name) ? dom.window[name].bind(dom.window) : dom.window[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of old) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  async function until(condition, label) {
    for (let n = 0; n < 150; n++) { if (condition()) return; await delay(10); }
    assert.fail(label);
  }
  function view(fetcher, { path = '/homeassistant/draft.yaml', readOnly = false } = {}) {
    const compartment = new Compartment();
    const editor = new EditorView({ parent: document.body,
      state: EditorState.create({ doc: 'entity_id: light.ba', selection: { anchor: 19 },
        extensions: [EditorView.editable.of(!readOnly), compartment.of(createHaEditorLsp(path, fetcher))] }),
    });
    return { editor, compartment };
  }
  const respond = (body, items) => new Response(JSON.stringify({ ...body, text: undefined, items, truncated: false }), { status: 200 });

  await t.test('marks diagnostics from the unsaved buffer and clears them after a correction', async () => {
    const calls = [];
    const { editor } = view(async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      return respond(body, body.text.includes('light.ba') ? [{ message: 'Unknown entity', severity: 2,
        range: { start: { line: 0, character: 11 }, end: { line: 0, character: 19 } } }] : []);
    });
    try {
      await delay(400);
      assert.equal(calls.length, 0, 'diagnostics must be debounced');
      await until(() => diagnosticCount(editor.state) === 1, 'expected draft diagnostic');
      assert.equal(calls[0].text, 'entity_id: light.ba');
      editor.dispatch({ changes: { from: 11, to: editor.state.doc.length, insert: 'light.good' } });
      await until(() => calls.length === 2 && document.body.textContent.includes('HA YAML: checked'), 'expected corrected draft result');
      assert.equal(diagnosticCount(editor.state), 0);
      assert.equal(calls[1].version, 1);
    } finally { editor.destroy(); }
  });

  await t.test('completion replaces the complete dotted identifier in the draft', async () => {
    const { editor } = view(async (url, init) => respond(JSON.parse(init.body), url.endsWith('completions') ? [{ label: 'light.bathroom' }] : []));
    try {
      editor.focus();
      startCompletion(editor);
      await until(() => currentCompletions(editor.state).length > 0, 'expected CodeMirror completion');
      assert.equal(currentCompletions(editor.state)[0].label, 'light.bathroom');
      await delay(100); // CodeMirror's default interactionDelay guards accidental accepts.
      assert.equal(acceptCompletion(editor), true);
      assert.equal(editor.state.doc.toString(), 'entity_id: light.bathroom');
    } finally { editor.destroy(); }
  });

  await t.test('edit-undo aborts pending requests and stale responses cannot restore diagnostics', async () => {
    let pending;
    const { editor } = view((_url, init) => new Promise((resolve) => { pending = { init, resolve }; }));
    try {
      await until(() => pending, 'expected request');
      const old = pending;
      editor.dispatch({ changes: { from: 0, insert: 'x' } });
      editor.dispatch({ changes: { from: 0, to: 1, insert: '' } });
      assert.equal(old.init.signal.aborted, true);
      old.resolve(respond(JSON.parse(old.init.body), [{ message: 'stale', severity: 1,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]));
      await delay(30);
      assert.equal(diagnosticCount(editor.state), 0);
    } finally { editor.destroy(); }
  });

  await t.test('completion aborts immediately on a document change', async () => {
    let pending;
    const { editor } = view((url, init) => url.endsWith('completions')
      ? new Promise((resolve) => { pending = { init, resolve }; }) : Promise.resolve(respond(JSON.parse(init.body), [])));
    try {
      editor.focus(); startCompletion(editor);
      await until(() => pending, 'expected completion request');
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'd' } });
      assert.equal(pending.init.signal.aborted, true);
      pending.resolve(respond(JSON.parse(pending.init.body), [{ label: 'stale.entity' }]));
      await delay(30);
      assert.equal(currentCompletions(editor.state).length, 0);
    } finally { editor.destroy(); }
  });

  await t.test('file/runtime reconfiguration and destroy abort their own view requests', async () => {
    const pending = [];
    const fetcher = (_url, init) => new Promise((resolve) => pending.push({ init, resolve }));
    const { editor, compartment } = view(fetcher);
    try {
      await until(() => pending.length === 1, 'expected initial request');
      editor.dispatch({ effects: compartment.reconfigure(createHaEditorLsp('/homeassistant/other.yaml', fetcher)) });
      assert.equal(pending[0].init.signal.aborted, true);
      await until(() => pending.length === 2, 'expected new file request');
      assert.notEqual(JSON.parse(pending[0].init.body).editorId, JSON.parse(pending[1].init.body).editorId);
      editor.destroy();
      assert.equal(pending[1].init.signal.aborted, true);
    } finally { if (!editor.destroyed) editor.destroy(); }
  });

  await t.test('shared extensions keep fullscreen and inline views independently cancellable', async () => {
    const pending = [];
    const extension = createHaEditorLsp('/homeassistant/draft.yaml', (_url, init) => new Promise((resolve) => pending.push({ init, resolve })));
    const a = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'a: 1', extensions: [extension] }) });
    const b = new EditorView({ parent: document.body, state: EditorState.create({ doc: 'a: 2', extensions: [extension] }) });
    try {
      await until(() => pending.length === 2, 'expected one request per view');
      const first = pending.find((request) => JSON.parse(request.init.body).text === 'a: 1');
      const second = pending.find((request) => JSON.parse(request.init.body).text === 'a: 2');
      assert.notEqual(JSON.parse(first.init.body).editorId, JSON.parse(second.init.body).editorId);
      a.destroy();
      assert.equal(first.init.signal.aborted, true);
      assert.equal(second.init.signal.aborted, false);
      second.resolve(respond(JSON.parse(second.init.body), []));
      await until(() => b.dom.textContent.includes('HA YAML: checked'), 'second view must remain live');
    } finally { if (!a.destroyed) a.destroy(); b.destroy(); }
  });

  await t.test('closing the completion UI aborts a pending query without an edit', async () => {
    let pending;
    const { editor } = view((url, init) => url.endsWith('completions')
      ? new Promise((resolve) => { pending = { init, resolve }; }) : Promise.resolve(respond(JSON.parse(init.body), [])));
    try {
      editor.focus(); startCompletion(editor);
      await until(() => pending, 'expected query');
      closeCompletion(editor);
      await until(() => pending.init.signal.aborted, 'closed completion should abort');
      pending.resolve(respond(JSON.parse(pending.init.body), []));
    } finally { editor.destroy(); }
  });

  await t.test('read-only and sensitive-file views never call the bridge', async () => {
    let calls = 0;
    const fetcher = async (_url, init) => { calls++; return respond(JSON.parse(init.body), []); };
    const a = view(fetcher, { readOnly: true }).editor;
    const b = view(fetcher, { path: '/homeassistant/secrets.yml' }).editor;
    try {
      startCompletion(a); startCompletion(b);
      await delay(1000);
      assert.equal(calls, 0);
    } finally { a.destroy(); b.destroy(); }
  });

  await t.test('service failure remains visibly unavailable rather than reporting a clean draft', async () => {
    let available = false;
    const { editor } = view(async (_url, init) => available ? respond(JSON.parse(init.body), []) : new Response('{"error":"unavailable"}', { status: 503 }));
    try {
      await until(() => editor.dom.textContent.includes('HA YAML: unavailable'), 'expected visible unavailable state');
      available = true;
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'd' } });
      await until(() => editor.dom.textContent.includes('HA YAML: checked'), 'expected recovery after editing');
    }
    finally { editor.destroy(); }
  });
});
