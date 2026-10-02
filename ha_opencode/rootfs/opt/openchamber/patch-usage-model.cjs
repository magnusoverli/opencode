// Targeted patches for the immutable OpenChamber preview. Fail on source drift
// before writing anything; no runtime pins or backend ownership are changed.
const fs = require("node:fs");
const path = require("node:path");

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`Unexpected preview source: ${label}`);
  return source.replace(before, after);
}

function patchUsageModel(root) {
  const files = new Map();
  const edit = (file, before, after) => {
    const source = files.get(file) ?? fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    files.set(file, replaceOnce(source, before, after, file));
  };
  const quota = "packages/web/server/lib/quota/providers/codex.js";
  edit(quota, "Session expired \\u2014 please re-authenticate with OpenAI",
    "OpenAI usage authorization expired. Send a message to refresh your OpenCode sign-in, then refresh Usage. Reconnect OpenAI if chat also fails.");

  const config = "packages/ui/src/stores/useConfigStore.ts";
  const source = fs.readFileSync(path.join(root, config), "utf8").replace(/\r\n/g, "\n");
  const start = "                applyDefaultModelAgentSelection: (options) => {";
  const end = "                applyOpenCodeConfigDefaults: (directory, source = \"syncConfig\", config) => {";
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error("Unexpected preview model-selection boundary");
  const before = source.slice(source.indexOf(start), source.indexOf(end));
  let after = replaceOnce(before, "                    const {\n                        agentName: resolvedAgentName,",
    "                    let {\n                        agentName: resolvedAgentName,", config);
  after = replaceOnce(after, "                    set((state) => {", `                    // New chats inherit the last-used model stored by the composer.
                    // Missing/removed models fall back to the normal default cascade.
                    const last = useSelectionStore.getState().lastUsedProvider;
                    const remembered = last && hasProviderModel(providers, last.providerID, last.modelID);
                    if (remembered) {
                        if (resolvedProviderId !== last.providerID || resolvedModelId !== last.modelID) resolvedVariant = undefined;
                        resolvedProviderId = last.providerID;
                        resolvedModelId = last.modelID;
                    }

                    set((state) => {`, config);
  // Keep asynchronous provider/agent discovery from replacing this user choice.
  if (after.split('selectionSource: "auto",').length !== 3) throw new Error("Unexpected preview selection sources");
  after = after.replaceAll('selectionSource: "auto",', 'selectionSource: remembered ? "manual" : "auto",');
  files.set(config, source.replace(before, after));
  for (const [file, contents] of files) fs.writeFileSync(path.join(root, file), contents);
}

module.exports = { patchUsageModel };
if (require.main === module) {
  if (process.argv.length !== 3) throw new Error("Usage: patch-usage-model.cjs <preview-source-root>");
  patchUsageModel(process.argv[2]);
  console.log("OpenChamber uses managed V2 usage credentials and remembers the last model for new chats");
}
