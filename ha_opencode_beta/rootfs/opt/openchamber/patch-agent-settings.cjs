// Exact pinned-source patch; fail before writing on missing/duplicate anchors.
const fs = require('node:fs');
const path = require('node:path');
function patchAgentSettings(root, support = path.join(__dirname, 'agent-settings')) {
  const target = path.join(root, 'packages/web/server/lib/opencode/bootstrap-runtime.js');
  let source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  const before = '      normalizeTunnelSessionTtlMs,\n    });\n\n    notificationEmitRoutes.registerApiRoute();';
  if (source.split(before).length !== 2 || source.includes('registerManagedAgentRoutes')) throw new Error('Unexpected pinned agent settings mount');
  source = "import { registerManagedAgentRoutes } from './ha-agent-settings-routes.mjs';\n" + source.replace(before, `${before}\n\n    registerManagedAgentRoutes(app, { express });`);
  if (source.indexOf('    registerAuthAndAccessRoutes(app, {') < 0 || source.indexOf('    registerAuthAndAccessRoutes(app, {') > source.indexOf('    registerManagedAgentRoutes(app, {')) throw new Error('Agent settings auth mount changed');
  const routes = fs.readFileSync(path.join(support, 'routes.mjs'), 'utf8');
  fs.writeFileSync(target, source);
  fs.writeFileSync(path.join(path.dirname(target), 'ha-agent-settings-routes.mjs'), routes);
}
module.exports = { patchAgentSettings };
if (require.main === module) patchAgentSettings(process.argv[2], process.argv[3]);
