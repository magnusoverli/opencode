import { describe, it, expect } from "vitest";
import {
  assembleSections,
  byteLength,
  clampToBytes,
  describeSecretFindings,
  extractSecretValues,
  findSecrets,
} from "../lib/context-budget.js";

// ---------------------------------------------------------------------------
// clampToBytes
// ---------------------------------------------------------------------------

describe("clampToBytes", () => {
  it("leaves text under budget untouched", () => {
    const result = clampToBytes("line one\nline two", 1000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("line one\nline two");
  });

  it("cuts on a line boundary rather than mid-line", () => {
    const text = ["aaaa", "bbbb", "cccc"].join("\n"); // 14 bytes
    const result = clampToBytes(text, 10, { marker: "" });
    expect(result.truncated).toBe(true);
    // Whatever survives must be whole lines
    for (const line of result.text.split("\n")) {
      expect(["aaaa", "bbbb", "cccc", ""]).toContain(line);
    }
  });

  it("never exceeds the requested budget", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    for (const budget of [50, 120, 500]) {
      const result = clampToBytes(text, budget);
      expect(byteLength(result.text)).toBeLessThanOrEqual(budget);
    }
  });

  it("accounts for multi-byte characters", () => {
    // Each emoji is 4 bytes in UTF-8; a naive length check would overrun.
    const text = Array.from({ length: 40 }, () => "🏠🏠🏠🏠🏠").join("\n");
    const result = clampToBytes(text, 100);
    expect(byteLength(result.text)).toBeLessThanOrEqual(100);
  });

  it("returns empty text for a zero budget", () => {
    expect(clampToBytes("anything", 0).text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// assembleSections
// ---------------------------------------------------------------------------

describe("assembleSections", () => {
  const sections = [
    { id: "header", priority: 0, required: true, text: "H" },
    { id: "big", priority: 1, text: "B".repeat(100) },
    { id: "small", priority: 2, text: "S" },
  ];

  it("emits sections in priority order", () => {
    const result = assembleSections(sections, 1000);
    expect(result.includedSections).toEqual(["header", "big", "small"]);
    expect(result.text.startsWith("H")).toBe(true);
  });

  it("skips a section that does not fit but keeps later smaller ones", () => {
    const result = assembleSections(sections, 40);
    expect(result.includedSections).toEqual(["header", "small"]);
    expect(result.droppedSections).toEqual(["big"]);
  });

  it("ignores empty sections", () => {
    const result = assembleSections([{ id: "blank", priority: 1, text: "   " }], 100);
    expect(result.includedSections).toEqual([]);
    expect(result.text).toBe("");
  });

  it("keeps the budget as a hard ceiling even with a required section", () => {
    const oversized = [{ id: "header", priority: 0, required: true, text: "X".repeat(500) }];
    const result = assembleSections(oversized, 100);
    expect(byteLength(result.text)).toBeLessThanOrEqual(100);
  });

  it("breaks priority ties by declaration order", () => {
    const tied = [
      { id: "second", priority: 1, text: "2" },
      { id: "first", priority: 1, text: "1" },
    ];
    // Declaration order decides, not id ordering
    expect(assembleSections(tied, 100).includedSections).toEqual(["second", "first"]);
  });
});

// ---------------------------------------------------------------------------
// extractSecretValues
// ---------------------------------------------------------------------------

describe("extractSecretValues", () => {
  // Certificates and private keys live in block scalars, and a scan that only
  // reads `key: value` lines cannot see a single byte of them.
  it("reads block scalars, where certificates and private keys actually live", () => {
    const secrets = [
      "wifi_password: hunter2hunter2",
      "client_cert: |",
      "  -----BEGIN PRIVATE KEY-----",
      "  MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ",
      "  -----END PRIVATE KEY-----",
      "api_base: https://example.invalid",
    ].join("\n");

    const values = extractSecretValues(secrets);

    expect(values).toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ");
    expect(values).toContain("hunter2hunter2");
    expect(values).toContain("https://example.invalid");
  });

  it("catches a note that quotes a value taken from a block scalar", () => {
    const secrets = ["cert: |", "  MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ"].join("\n");
    const note = "Reuse MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ for the broker.";
    expect(findSecrets(note, extractSecretValues(secrets))).not.toHaveLength(0);
  });

  it("does not swallow the key that follows a block scalar", () => {
    const secrets = ["cert: |", "  line-one-of-the-key", "next_secret: plainvalue123"].join("\n");
    expect(extractSecretValues(secrets)).toContain("plainvalue123");
  });

  it("reads values from a flat secrets.yaml", () => {
    const secrets = [
      "# My secrets",
      "wifi_password: supersecret123",
      "api_token: abcdef1234567890",
      "",
    ].join("\n");
    const values = extractSecretValues(secrets);
    expect(values).toContain("supersecret123");
    expect(values).toContain("abcdef1234567890");
  });

  it("skips comments and short values", () => {
    const secrets = ["# comment: not_a_secret", "pin: 1234", "long_one: abcdefghij"].join("\n");
    const values = extractSecretValues(secrets);
    expect(values).toEqual(["abcdefghij"]);
  });

  it("strips quotes and trailing comments but keeps a quoted hash", () => {
    const secrets = ['a: "hunter2hunter2" # note', "b: 'pass#word123'"].join("\n");
    const values = extractSecretValues(secrets);
    expect(values).toContain("hunter2hunter2");
    expect(values).toContain("pass#word123");
  });

  it("returns an empty list for empty input", () => {
    expect(extractSecretValues("")).toEqual([]);
    expect(extractSecretValues(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findSecrets
// ---------------------------------------------------------------------------

describe("findSecrets", () => {
  it("detects a JWT-shaped token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(findSecrets(`token is ${jwt}`)).toEqual([{ kind: "json_web_token" }]);
  });

  it("detects inline credentials", () => {
    expect(findSecrets("password: hunter2hunter2").some((f) => f.kind === "inline_credential")).toBe(true);
    expect(findSecrets("api_key=abcdefgh12345678").some((f) => f.kind === "inline_credential")).toBe(true);
  });

  it("detects a URL with embedded credentials", () => {
    const findings = findSecrets("mqtt://user:hunter2@broker.local");
    expect(findings.some((f) => f.kind === "url_with_credentials")).toBe(true);
  });

  it("detects a value reused from secrets.yaml", () => {
    const findings = findSecrets("the broker uses swordfish99 to connect", ["swordfish99"]);
    expect(findings).toEqual([{ kind: "secrets_yaml_value" }]);
  });

  it("detects a credential written out in prose", () => {
    const findings = findSecrets("The broker password is hunter2hunter2 for user admin.");
    expect(findings.some((f) => f.kind === "prose_credential")).toBe(true);
  });

  it("does not flag prose that only talks about a credential", () => {
    const benign = [
      "The MQTT password is stored in secrets.yaml.",
      "The API key is unchanged since the migration.",
      "The access token is configured under Settings.",
      "The password is different for each device.",
    ];
    for (const text of benign) {
      expect(findSecrets(text), text).toEqual([]);
    }
  });

  it("does not flag ordinary Home Assistant prose", () => {
    const text =
      "Kitchen lights use switch.kitchen_main; the MQTT broker password is stored as !secret mqtt_password.";
    expect(findSecrets(text, ["swordfish99"])).toEqual([]);
  });

  it("does not flag a !secret reference", () => {
    expect(findSecrets("password: !secret wifi_password")).toEqual([]);
  });

  it("never returns the matched value", () => {
    const findings = findSecrets("password: hunter2hunter2", ["hunter2hunter2"]);
    expect(JSON.stringify(findings)).not.toContain("hunter2");
  });
});

describe("describeSecretFindings", () => {
  it("summarizes distinct kinds without repeating", () => {
    const text = describeSecretFindings([
      { kind: "inline_credential" },
      { kind: "inline_credential" },
      { kind: "secrets_yaml_value" },
    ]);
    expect(text).toBe("an inline password or API key, a value that also appears in secrets.yaml");
  });
});
