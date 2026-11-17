// Node's removeHeader('transfer-encoding') disables automatic chunked framing.
// Keep incoming stream framing until a parsed body is available to reserialize.
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(process.argv[2], 'server/lib/opencode/proxy.js');
const source = fs.readFileSync(file, 'utf8');
const before = `    // http-proxy copies the incoming headers verbatim, so a request that
    // arrived \`Transfer-Encoding: chunked\` (a tunnel or reverse proxy
    // re-framing the body, including empty ones) would carry that header on
    // top of the framing the outgoing client chooses itself; Bun's client
    // also writes \`content-length\` for bodies it can size, empty ones
    // included. OpenCode rejects a request carrying both framing headers as
    // ambiguous. Drop the copied header on every proxied request and let
    // the client frame it: content-length once the body length is known,
    // chunked while the original body is still streaming through.
    proxyReq.removeHeader('transfer-encoding');
    const body = serializeParsedBody(req, proxyReq);
    if (!body) return;
    proxyReq.removeHeader('transfer-encoding');`;
const after = `    // Unparsed routes (including prompt) still stream the incoming body.
    // Removing transfer-encoding here would disable Node's chunked framing
    // and make the backend see an empty body. Reframe only parsed bodies.
    const body = serializeParsedBody(req, proxyReq);
    if (!body) return;
    proxyReq.removeHeader('transfer-encoding');`;
if (source.split(before).length !== 2) throw new Error('Review pinned proxy body framing implementation');
fs.writeFileSync(file + '.ha-patched', source.replace(before, after));
fs.renameSync(file + '.ha-patched', file);
console.log('OpenChamber preserves streaming request framing and reframes parsed bodies');
