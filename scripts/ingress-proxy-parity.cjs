const assert = require("node:assert/strict");

// Review channel-specific additions explicitly. Shared OAuth, streaming and
// request framing must still compare byte-for-byte in both contract suites.
function withoutBetaEditorRoute(source) {
  const additions = [
    'const { validEditorIngressOrigin } = require("./editor-ingress-origin.js");\n',
    `  const editorRequest = /^\\/api\\/ha-editor-lsp\\/(?:diagnostics|completions)$/.test(upstreamPath.split("?", 1)[0]);
  if (editorRequest && (!isAllowedRemote(remoteAddress) ||
      !validEditorIngressOrigin(req.headers, ingressPath, ALLOW_ANY_REMOTE))) {
    res.writeHead(403, noStoreHeaders({ "content-type": "application/json" }));
    res.end(JSON.stringify({ error: "Editor language service request denied" }));
    return;
  }
`,
    `  // TLS terminates before the app. Having checked the original browser authority
  // at the trusted Ingress boundary, normalize this read-only route's Origin to
  // the internal hop. The backend keeps its strict same-origin/auth checks and
  // never has to trust caller-supplied X-Forwarded-* claims or a bypass header.
  if (editorRequest) headers.origin = \`http://\${headers.host}\`;
`,
  ];
  for (const addition of additions) {
    assert.equal(source.split(addition).length, 2, "Expected exactly one reviewed beta-only editor addition");
    source = source.replace(addition, "");
  }
  return source;
}

function withoutBetaStorageScope(source) {
  source = source.replace(/\r\n/g, "\n");
  // Reviewed beta-only #208 fix: exact token-sharing authorization path.
  const oauthPaths = '!["/oauth/authorize", "/api/accounts/authorize"].includes(authorizeUrl.pathname)';
  assert.equal(source.split(oauthPaths).length, 2, "Expected one reviewed beta-only OAuth path addition");
  source = source.replace(oauthPaths, 'authorizeUrl.pathname !== "/oauth/authorize"');
  for (const addition of [
    'const { installBrowserStorageScope } = require("./openchamber-browser-storage.js");\n',
    '  const storageNamespace = process.env.ADDON_CHANNEL === "beta" ? "ha-opencode-beta" : "ha-opencode-stable";\n',
    '    + `  (${installBrowserStorageScope.toString()})(window, ${JSON.stringify(storageNamespace)});\\n`\n',
  ]) {
    assert.equal(source.split(addition).length, 2, "Expected one reviewed beta-only storage addition");
    source = source.replace(addition, "");
  }
  return source;
}

module.exports = { withoutBetaEditorRoute, withoutBetaStorageScope };
