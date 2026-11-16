// Add Home Assistant guidance without changing provider methods, ordering,
// token ownership or upstream's automatic completion/cancellation lifecycle.
const fs = require("node:fs");
const path = require("node:path");

// Export the exact injected read-only sequence for the pinned-runtime contract.
const activationSteps = `await client.plugin.list();
      for (let check = 0; ; check++) {
        const { data: active } = await client.integration.list();
        if (active.some((entry) => entry.id === integrationId)) break;
        if (check >= 49) throw new Error('Provider integration is still starting. Please try again.');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }`;

const handoffBefore = `        {attempt.url && (
          <div className="flex items-center gap-2">`;
const handoffAfter = `        {/* HA_SIGNIN_LINK_START */}
        {integrationId === 'openai' && shouldOpenAuthorizationUrl(integrationId, attempt.url) && (
          <div data-testid="ha-openai-signin-link" className="space-y-2">
            <a href={attempt.url} target="_blank" rel="noopener noreferrer" className="underline typography-ui-label">
              {attempt.url.includes('/__ha_openai_oauth_bridge?') ? 'Open sign-in handoff' : 'Open authorization page'}
            </a>
            <p className="typography-meta text-muted-foreground">
              If no tab opened automatically, select the link above.
              {attempt.url.includes('/__ha_openai_oauth_bridge?') && (
                <> Keep the handoff tab open, choose Continue to OpenAI sign-in there, then return to it
                and paste the full failed localhost callback URL into its callback field.
                OpenChamber will detect completion automatically.</>
              )}
            </p>
          </div>
        )}
        {/* HA_SIGNIN_LINK_END */}
${handoffBefore}`;

function patchProviderSignin(root) {
  const target = path.join(root, "packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx");
  const source = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  const before = `    <div className={cn('space-y-4', className)}>
      {methods.map((method) => {`;
  if (source.split(before).length !== 2 || source.includes("ha-openai-signin-guidance")) {
    throw new Error("Unexpected preview provider sign-in source");
  }
  const connectBefore = `      const { data } = await sdk().integration.oauth.connect({`;
  if (source.split(connectBefore).length !== 2) throw new Error("Unexpected preview OAuth connection source");
  if (source.split(handoffBefore).length !== 2) throw new Error("Unexpected preview OAuth link source");
  const connectAfter = `      // Plugin listing can race integration publication on cold startup.
      // Wait for the SAME scoped integration before starting one authorization.
      const client = sdk();
      ${activationSteps}
      const { data } = await client.integration.oauth.connect({`;
  const after = `    <div className={cn('space-y-4', className)}>
      {integrationId === 'openai' && (
        <p data-testid="ha-openai-signin-guidance" className="typography-meta text-muted-foreground">
          Home Assistant runs OpenCode remotely. For sign-in without callback pasting, choose{' '}
          <strong>Codex device code (legacy)</strong>, open the verification link and enter the displayed code.
          Keep this screen open: OpenChamber detects approval automatically, with no restart or Terminal switch.
          This is a separate legacy Codex login, not the newer <strong>Sign in with ChatGPT</strong> method.
          For that newer method, use its sign-in handoff and paste the full failed localhost callback URL there.
          OpenCode handles credential storage and refresh for both methods. Never share callback URLs.
        </p>
      )}
      {methods.map((method) => {`;
  fs.writeFileSync(target, source.replace(before, after).replace(connectBefore, connectAfter).replace(handoffBefore, handoffAfter));
}

module.exports = { patchProviderSignin, activationSteps };
if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: patch-provider-signin.cjs <preview-source-root>");
  patchProviderSignin(process.argv[2]);
}
