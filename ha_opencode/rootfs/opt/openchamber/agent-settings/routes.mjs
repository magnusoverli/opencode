// Mounted after upstream UI/LAN/Ingress authentication, before the unguarded
// upstream agent filesystem routes. No credentials enter request bodies/config.
export function registerManagedAgentRoutes(app, { express, bridge = () => globalThis[Symbol.for("ha.openchamber.agent-settings")] }) {
  const router = express.Router();
  router.use(['/api/config/agents', '/api/config/disabled-agents'], express.json({ limit: 96 * 1024 }));
  const route = operation => async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const controller = bridge();
      if (!controller) return res.status(503).json({ error: "Managed agent settings are unavailable" });
      const input = req.body ?? {};
      if (req.query.scope !== undefined) {
        if (input.scope !== undefined && input.scope !== req.query.scope) return res.status(400).json({ error: 'Conflicting agent scopes' });
        input.scope = req.query.scope;
      }
      const result = await controller.handle(operation, req.params.name, input, req.query.directory);
      res.json(result);
    } catch (error) {
      const status = [400, 403, 404, 409, 413, 422, 503].includes(error.status) ? error.status : 503;
      res.status(status).json({ error: error.name === "AgentSettingsError" ? error.message : "Managed agent settings could not be applied" });
    }
  };
  router.get('/api/config/disabled-agents', route('disabled'));
  router.get('/api/config/agents/:name', route('metadata'));
  router.get('/api/config/agents/:name/config', route('config'));
  router.get('/api/config/agents/:name/permissions', route('permissions'));
  router.post('/api/config/agents/:name', route('create'));
  router.patch('/api/config/agents/:name', route('update'));
  router.delete('/api/config/agents/:name', route('delete'));
  router.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid or oversized agent settings request' }));
  app.use(router);
}
