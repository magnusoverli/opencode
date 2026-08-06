import { describe, expect, it } from "vitest";
import { buildHeadlessPermissionConfig, parseAgentFrontmatter } from "../lib/headless-permissions.js";

describe("headless permissions", () => {
  it("allows an absolute agent rule at the worktree-relative edit path", () => {
    const result = buildHeadlessPermissionConfig({
      markdownAgents: [
        {
          name: "reporter",
          agent: {
            permission: {
              edit: {
                "*": "ask",
                "/homeassistant/docs/**": "allow",
              },
            },
          },
        },
      ],
    });

    expect(result.permission.edit).toBe("deny");
    expect(result.agent.reporter.permission.edit).toEqual({
      "*": "deny",
      "/homeassistant/docs/**": "allow",
      "docs/**": "allow",
    });
  });

  it("preserves explicit write permission while denying unresolved asks", () => {
    const result = buildHeadlessPermissionConfig({
      config: {
        permission: { edit: "allow" },
        agent: {
          writer: { permission: { edit: "allow" } },
          cautious: { permission: { edit: "ask" } },
        },
      },
    });

    expect(result.permission.edit).toBe("allow");
    expect(result.agent.writer.permission.edit).toBe("allow");
    expect(result.agent.cautious.permission.edit).toBe("deny");
  });

  it("parses standard agent markdown frontmatter", () => {
    expect(
      parseAgentFrontmatter(`---\ndescription: Reports\npermission:\n  edit:\n    /homeassistant/docs/**: allow\n---\nWrite reports.`),
    ).toEqual({
      description: "Reports",
      permission: { edit: { "/homeassistant/docs/**": "allow" } },
    });
  });
});
