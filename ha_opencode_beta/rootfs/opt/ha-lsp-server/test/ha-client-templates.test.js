import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const serverSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "server.js"),
  "utf8"
);

/**
 * Guards the Jinja globals the LSP sends to Home Assistant's /api/template.
 *
 * server.js registers an LSP connection at import time, so the client cannot be
 * imported here without starting a server. These assertions read the source
 * instead — crude, but enough to stop a nonexistent global being reintroduced.
 *
 * Home Assistant's device template extension registers only device_entities,
 * device_id, device_name, device_attr and is_device_attr. There is no all-device
 * devices() global to match areas()/floors()/labels(); calling one makes Core log
 * "Template variable error: 'devices' is undefined" on every cache warm-up.
 */
describe("Home Assistant template globals", () => {
  it("does not call the nonexistent devices() global", () => {
    expect(serverSource).not.toMatch(/\bdevices\(\)/);
  });

  it("derives the device list from entities in states", () => {
    expect(serverSource).toMatch(/map\('device_id'\)/);
  });

  it("still uses the registry globals Home Assistant does provide", () => {
    for (const global of ["areas()", "floors()", "labels()"]) {
      expect(serverSource).toContain(global);
    }
  });
});
