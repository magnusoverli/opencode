// Add Home Assistant guidance without changing provider methods, ordering,
// token ownership or upstream's automatic completion/cancellation lifecycle.
const fs = require("node:fs");
const path = require("node:path");

function patchProviderSignin(root) {
  const target = path.join(root, "packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx");
  const source = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  const before = `    <div className={cn('space-y-4', className)}>
      {methods.map((method) => {`;
  if (source.split(before).length !== 2 || source.includes("ha-openai-signin-guidance")) {
    throw new Error("Unexpected preview provider sign-in source");
  }
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
  fs.writeFileSync(target, source.replace(before, after));
}

module.exports = { patchProviderSignin };
if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: patch-provider-signin.cjs <preview-source-root>");
  patchProviderSignin(process.argv[2]);
}
