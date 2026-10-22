const path = require("node:path");
const { registerIngressPatchTests } = require("../../scripts/openchamber-ingress-patch-tests.cjs");

registerIngressPatchTests(path.join(__dirname, ".."));
