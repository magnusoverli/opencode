import { describe, expect, it } from "vitest";
import {
  filterToolsForProfile,
  getToolProfile,
  isToolAllowedInProfile,
  normalizeToolProfile,
  profileDisabledToolMessage,
} from "../lib/tool-profiles.js";

const tools = [
  { name: "get_home_context" },
  { name: "get_integration_docs" },
  { name: "write_config_safe" },
  { name: "esphome_config_read" },
  { name: "esphome_config_update" },
  { name: "call_service" },
  { name: "hab_run" },
];

describe("MCP tool profiles", () => {
  it("defaults unknown values to the backwards-compatible full surface", () => {
    expect(normalizeToolProfile()).toBe("full");
    expect(normalizeToolProfile("not-a-profile")).toBe("full");
    expect(getToolProfile("FULL").name).toBe("full");
  });

  it("keeps only diagnostics in the compact profile", () => {
    expect(filterToolsForProfile(tools, "compact").map((tool) => tool.name)).toEqual([
      "get_home_context",
    ]);
    expect(isToolAllowedInProfile("call_service", "compact")).toBe(false);
  });

  it("adds safe configuration tools without administrative capabilities", () => {
    expect(filterToolsForProfile(tools, "configuration").map((tool) => tool.name)).toEqual([
      "get_home_context",
      "get_integration_docs",
      "write_config_safe",
      "esphome_config_read",
      "esphome_config_update",
    ]);
    expect(isToolAllowedInProfile("hab_run", "configuration")).toBe(false);
  });

  it("leaves the full profile unchanged and explains scoped rejections", () => {
    expect(filterToolsForProfile(tools, "full")).toEqual(tools);
    expect(isToolAllowedInProfile("call_service", "full")).toBe(true);
    expect(profileDisabledToolMessage("call_service", "compact")).toContain("full profile");
  });
});
