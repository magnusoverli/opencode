#!/usr/bin/env node
// Patch the pinned OpenChamber web bundle for Home Assistant Ingress.
// The upstream app is built for origin-root hosting; HA serves add-ons under
// /api/hassio_ingress/<token>, so root-relative assets and API URLs need help.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function fail(message) {
  console.error(`OpenChamber ingress patch failed: ${message}`);
  process.exit(1);
}

function replaceOnce(content, search, replacement, label) {
  const count = content.split(search).length - 1;
  if (count !== 1) {
    fail(`${label} expected 1 match, found ${count}`);
  }
  return content.replace(search, replacement);
}

function replaceRegexOnce(content, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  const matches = [...content.matchAll(globalPattern)];
  if (matches.length !== 1) {
    fail(`${label} expected 1 match, found ${matches.length}`);
  }
  return content.replace(pattern, replacement);
}

function writeIfChanged(filePath, content) {
  const current = fs.readFileSync(filePath, "utf8");
  if (current !== content) {
    fs.writeFileSync(filePath, content);
  }
}

const packageRoot = process.argv[2] || path.join(execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
}).trim(), "@openchamber", "web");
const distDir = path.join(packageRoot, "dist");
const assetsDir = path.join(distDir, "assets");
const indexPath = path.join(distDir, "index.html");

// 2.2.0 fixes sub-path joining upstream. Guard that implementation instead of
// rewriting the obsolete origin-only builder in minified output.
const runtimeUrlSource = fs.readFileSync(path.join(packageRoot, "../ui/src/lib/runtime-url.ts"), "utf8");
if (!runtimeUrlSource.includes("const base = new URL(baseUrl);") ||
    !runtimeUrlSource.includes("const url = new URL(`${base.origin}${base.pathname.replace(/\\/+$/, '')}${normalizedPath}`);")) {
  fail("upstream sub-path-preserving API URL builder changed");
}

if (!fs.existsSync(indexPath)) {
  fail(`index.html not found at ${indexPath}`);
}
if (!fs.existsSync(assetsDir)) {
  fail(`assets directory not found at ${assetsDir}`);
}

let html = fs.readFileSync(indexPath, "utf8");
html = html.replace(/\s*<script\b[^>]*\bdata-ha-ingress-runtime\b[^>]*>[\s\S]*?<\/script>/g, "");
html = replaceOnce(
  html,
  "const baseUrl = location.origin;",
  "const ingressBaseMatch = location.pathname.match(/^(\\/api\\/hassio_ingress\\/[^/]+)/);\n      const baseUrl = location.origin + (ingressBaseMatch ? ingressBaseMatch[1] : '');",
  "PWA manifest base URL"
);
if (!html.includes("data-ha-ingress-runtime")) {
  html = html.replace(
    /\s*<script type="module"/,
    '\n    <script data-ha-ingress-runtime src="__openchamber_ingress_runtime.js"></script>\n    <script type="module"'
  );
}

// Make initial static assets relative to the current iframe URL. The browser
// then requests them under /api/hassio_ingress/<token>/..., which Supervisor
// forwards back to this add-on.
html = html
  .replace(/\b(href|src)="\/(assets\/[^"#?]+(?:[?#][^"]*)?)"/g, '$1="$2"')
  .replace(/\bhref="\/(favicon[^"#?]*(?:[?#][^"]*)?)"/g, 'href="$1"')
  .replace(/\bhref="\/(apple-touch-icon[^"#?]*(?:[?#][^"]*)?)"/g, 'href="$1"');
writeIfChanged(indexPath, html);

const jsFiles = fs.readdirSync(assetsDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => path.join(assetsDir, name));
const cssFiles = fs.readdirSync(assetsDir)
  .filter((name) => name.endsWith(".css"))
  .map((name) => path.join(assetsDir, name));

// Every minified helper and variable name below is minifier-assigned and drifts
// between OpenChamber releases (e.g. qo/Jo in 1.13.8, mn/Sn in 1.13.9, da/ma in
// 1.16.x). Each pattern therefore captures the names structurally and reuses
// them via a function replacement instead of hardcoding them, so the patch
// survives minor version bumps. Validated against 1.14.x through 1.21.0.
const runtimeUrlPattern =
  /try\{return new URL\((\w+),`\$\{(\w+)\.replace\(\/\\\/\+\$\/,""\)\}\/`\)\.toString\(\)\}catch\{return \1\}\}/;
const runtimeUrlReplacement = (_m, arg, base) =>
  'try{return new URL(' + arg + '.replace(/^\\/+/,""),`${' + base + '.replace(/\\/+$/,"")}/`).toString()}catch{return ' + arg + '}}';

const apiClassifierPattern =
  /(\w+)=>\1\.startsWith\("\/api\/"\)\|\|\1==="\/api"\|\|\1\.startsWith\("\/auth\/"\)\|\|\1==="\/auth"\|\|\1==="\/health"/;
const apiClassifierReplacement = (_m, p) =>
  p + '=>!' + p + '.startsWith("/api/hassio_ingress/")&&(' + p + '.startsWith("/api/")||' + p + '==="/api"||' + p + '.startsWith("/auth/")||' + p + '==="/auth"||' + p + '==="/health")';

let patchedRuntimeUrl = false;
let patchedApiClassifier = false;
let patchedServiceWorker = false;
let patchedViteAssetsUrl = false;
let patchedVitePreloadBaseUrl = false;
let terminalWasmReferences = 0;

for (const filePath of jsFiles) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  if (runtimeUrlPattern.test(content)) {
    content = replaceRegexOnce(content, runtimeUrlPattern, runtimeUrlReplacement, "runtime URL builder");
    patchedRuntimeUrl = true;
  }

  // The app classifies "/api/*", "/auth/*" and "/health" paths as its own API
  // and prefixes them with the API base URL. The HA ingress base itself starts
  // with /api/, so an already-prefixed pathname like
  // /api/hassio_ingress/<token>/api/fs/read matches the classifier again and
  // every fetch layer adds one more prefix. Requests then reach OpenChamber
  // with a residual ingress prefix, fall onto its /api -> OpenCode proxy mount,
  // and OpenCode answers with its web UI HTML instead of JSON.
  if (apiClassifierPattern.test(content)) {
    content = replaceRegexOnce(content, apiClassifierPattern, apiClassifierReplacement, "API path classifier");
    patchedApiClassifier = true;
  }

  if (content.includes('if("serviceWorker"in navigator){')) {
    content = replaceOnce(
      content,
      'if("serviceWorker"in navigator){',
      'if(false&&"serviceWorker"in navigator){',
      "service worker registration"
    );
    patchedServiceWorker = true;
  }

  // Vite emitted this helper in older OpenChamber bundles, but 1.14.0 switched
  // to relative dynamic imports and no longer includes it.
  if (/assetsURL=function\((\w+)\)\{return"\/"\+\1\}/.test(content)) {
    content = replaceRegexOnce(
      content,
      /assetsURL=function\((\w+)\)\{return"\/"\+\1\}/,
      'assetsURL=function($1){return $1}',
      "Vite preload asset URL helper"
    );
    patchedViteAssetsUrl = true;
  }

  if (/("modulepreload",\w+=function\()(\w+)(\)\{return)"\/"\+\2(\},\w+=\{\})/.test(content)) {
    content = replaceRegexOnce(
      content,
      /("modulepreload",\w+=function\()(\w+)(\)\{return)"\/"\+\2(\},\w+=\{\})/,
      "$1$2$3 $2$4",
      "Vite preload base URL helper"
    );
    patchedVitePreloadBaseUrl = true;
  }

  // Unlike fetch("assets/..."), new URL(..., import.meta.url) resolves against
  // this chunk in dist/assets/, not the document <base>. Make the terminal core
  // a sibling asset before stripping root paths, or it becomes assets/assets/.
  content = content.replace(
    /new URL\(\s*(["'`])\/?assets\/(ghostty-vt-[\w-]+\.wasm)\1\s*,\s*import\.meta\.url\s*\)/g,
    (_match, quote, file) => {
      terminalWasmReferences += 1;
      if (!fs.existsSync(path.join(assetsDir, file))) {
        fail(`terminal WebAssembly asset not found: ${file}`);
      }
      return `new URL(${quote}./${file}${quote},import.meta.url)`;
    }
  );
  content = content.replace(/(["'`])\/assets\//g, "$1assets/");

  if (content !== original) {
    fs.writeFileSync(filePath, content);
  }
}

if (terminalWasmReferences !== 1) {
  fail(`terminal WebAssembly URL expected 1 match, found ${terminalWasmReferences}`);
}

const rootAssetReferences = jsFiles.flatMap((filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  return /["'`]\/assets\//.test(content) ? [path.basename(filePath)] : [];
});
if (rootAssetReferences.length > 0) {
  fail(`root asset references remain in JS: ${rootAssetReferences.join(", ")}`);
}

const rootVitePreloadHelpers = jsFiles.flatMap((filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  return /"modulepreload",\w+=function\((\w+)\)\{return"\/"\+\1\},\w+=\{\}/.test(content)
    ? [path.basename(filePath)]
    : [];
});
if (rootVitePreloadHelpers.length > 0) {
  fail(`root Vite preload helpers remain in JS: ${rootVitePreloadHelpers.join(", ")}`);
}

// URLs inside a stylesheet resolve against the stylesheet location, not the
// document <base>. The CSS files live in dist/assets/ alongside the fonts they
// reference, so /assets/<file> must become the same-directory reference
// <file>; "assets/<file>" would resolve to /assets/assets/<file> and 404.
for (const filePath of cssFiles) {
  const content = fs.readFileSync(filePath, "utf8");
  const patched = content
    .replace(/url\(\/assets\//g, "url(")
    .replace(/url\(\"\/assets\//g, 'url("')
    .replace(/url\('\/assets\//g, "url('");

  if (content !== patched) {
    fs.writeFileSync(filePath, patched);
  }
}

const cssRootAssetReferences = cssFiles.flatMap((filePath) => {
  const content = fs.readFileSync(filePath, "utf8");
  return /url\((?:["'])?\/assets\//.test(content) ? [path.basename(filePath)] : [];
});
if (cssRootAssetReferences.length > 0) {
  fail(`root asset references remain in CSS: ${cssRootAssetReferences.join(", ")}`);
}

if (!patchedRuntimeUrl) {
  fail("runtime URL builder pattern not found");
}
if (!patchedApiClassifier) {
  fail("API path classifier pattern not found");
}
if (!patchedServiceWorker) {
  fail("service worker registration pattern not found");
}
if (!patchedViteAssetsUrl) {
  console.log("OpenChamber Vite preload asset helper not present; skipping helper patch");
}
if (!patchedVitePreloadBaseUrl) {
  console.log("OpenChamber Vite preload base URL helper not present; skipping helper patch");
}

console.log("OpenChamber bundle patched for Home Assistant Ingress");
