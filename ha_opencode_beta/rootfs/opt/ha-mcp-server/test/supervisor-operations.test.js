import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOG_LINES,
  MAX_LOG_CHARS,
  MAX_LIST_LIMIT,
  formatSupportLog,
  projectBackupPosture,
  projectResolution,
  projectStoreAudit,
  projectSupervisorHealth,
  projectSupervisorMetrics,
  redactSensitiveText,
  sanitizeRepositorySource,
} from "../lib/supervisor-operations.js";

describe("Supervisor operation projections", () => {
  it("projects health evidence while omitting network, host, Resolution, and job secrets", () => {
    const data = projectSupervisorHealth({
      supervisor: {
        version: "2026.07.5",
        version_latest: "2026.08.0",
        update_available: true,
        channel: "stable",
        arch: "amd64",
        supported: true,
        healthy: false,
        ip_address: "192.168.5.33",
        feature_flags: ["internal"],
      },
      host: {
        hostname: "private-home",
        cpe: "cpe:private",
        operating_system: "Home Assistant OS",
        kernel: "6.12",
        disk_free: 10,
        disk_total: 100,
        disk_used: 90,
        disk_life_time: 7,
        dt_synchronized: true,
        use_ntp: true,
      },
      network: {
        host_internet: true,
        supervisor_internet: false,
        interfaces: [{
          interface: "eth0",
          type: "ethernet",
          connected: true,
          primary: true,
          mac: "aa:bb:cc:dd:ee:ff",
          ipv4: { address: ["192.168.5.33/24"], gateway: "192.168.5.1" },
          wifi: { ssid: "Private WiFi" },
        }],
      },
      resolution: {
        issues: [{ type: "disk", reference: "secret-disk" }],
        unhealthy: [{ type: "network" }],
        unsupported: [],
        suggestions: [{ type: "fix" }],
      },
      jobs: {
        jobs: [{ done: false, errors: [{ message: "token=private" }] }, { done: true, errors: [{}] }],
      },
    });

    expect(data.supervisor).toMatchObject({ version: "2026.07.5", healthy: false, supported: true });
    expect(data.host).toMatchObject({ operating_system: "Home Assistant OS", disk_total: 100, time_synchronized: true });
    expect(data.connectivity.interfaces).toEqual([{ interface: "eth0", type: "ethernet", enabled: null, connected: true, primary: true }]);
    expect(data.resolution).toMatchObject({ issues: 1, unhealthy: 1, suggestions: 1 });
    expect(data.jobs).toEqual({ total: 2, active: 1, completed: 1, failed: 1 });

    const rendered = JSON.stringify(data);
    for (const forbidden of ["192.168.5.33", "private-home", "cpe:private", "aa:bb", "Private WiFi", "secret-disk", "token=private"]) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it("bounds Resolution records and removes identifiers while retaining approval guidance", () => {
    const data = projectResolution({
      issues: [
        { type: "disk", context: "system", reference: "serial-123", reference_extra: "token" },
        { type: "network", context: "host", reference: "eth0" },
      ],
      unhealthy: [{ type: "dns", context: "system" }],
      unsupported: [{ type: "hardware", context: "host" }],
      suggestions: [{ type: "repair", context: "system", auto: true, reference: "private" }],
      checks: [{ slug: "check_dns", enabled: true }, { slug: "check_disk", enabled: false }],
    }, { limit: 1 });

    expect(data.issues).toMatchObject({ total: 2, returned: 1, truncated: true });
    expect(data.issues.items[0]).toEqual({
      type: "disk",
      context: "system",
      auto: null,
      has_reference: true,
      has_reference_extra: true,
    });
    expect(JSON.stringify(data)).not.toContain("serial-123");
    expect(JSON.stringify(data)).not.toContain("private");
    expect(data.recommendations.join(" ")).toContain("explicit approval");
  });

  it("sorts and caps backups without returning storage locations", () => {
    const data = projectBackupPosture({
      days_until_stale: 3,
      backups: [
        {
          slug: "older",
          date: "2026-01-01T00:00:00Z",
          type: "full",
          size_bytes: 10,
          protected: false,
          compressed: true,
          locations: ["/backup/private"],
          content: { homeassistant: true, addons: ["addon"], folders: ["config"] },
        },
        {
          slug: "newer",
          date: "2026-01-03T00:00:00Z",
          type: "partial",
          size_bytes: 20,
          protected: true,
          compressed: false,
          locations: ["cloud://private", "/backup/private"],
          content: { homeassistant: false, addons: ["one", "two"], folders: [] },
        },
      ],
    }, { limit: 1, now: Date.parse("2026-01-05T00:00:00Z") });

    expect(data).toMatchObject({ total: 2, returned: 1, truncated: true, newest_age_days: 2 });
    expect(data.backups[0]).toMatchObject({ slug: "newer", age_days: 2, app_count: 2, location_count: 2 });
    expect(JSON.stringify(data)).not.toContain("private");
  });

  it("sanitizes credential-bearing repository sources and caps store records", () => {
    expect(sanitizeRepositorySource("https://user:password@example.test/repo.git?token=secret#fragment"))
      .toBe("https://example.test/repo.git");
    expect(sanitizeRepositorySource("git://alice:secret@example.test/repo?access_token=bad"))
      .toBe("git://example.test/repo");

    const data = projectStoreAudit({
      addons: [
        { slug: "current", name: "Current", installed: true, available: true, update_available: false, version: "1", version_latest: "1" },
        { slug: "update", name: "Update api_key=verysecretvalue", installed: true, available: true, update_available: true, version: "1", version_latest: "2" },
      ],
      repositories: [{
        slug: "repo",
        name: "Repo",
        maintainer: "Maintainer",
        source: "https://user:password@example.test/repo.git?token=secret#fragment",
      }],
    }, { limit: 1 });

    expect(data.apps).toMatchObject({ total: 2, installed: 2, updates_available: 1, returned: 1, truncated: true });
    expect(data.apps.items[0].slug).toBe("update");
    expect(data.apps.items[0].name).toBe("Update api_key=<redacted>");
    expect(data.repositories.items[0].source).toBe("https://example.test/repo.git");
    expect(JSON.stringify(data)).not.toContain("password");
    expect(JSON.stringify(data)).not.toContain("token=secret");
    expect(JSON.stringify(data)).not.toContain("verysecretvalue");
  });

  it("normalizes only documented stats fields", () => {
    expect(projectSupervisorMetrics({
      cpu_percent: 10.5,
      memory_usage: 10,
      memory_limit: 20,
      memory_percent: 50,
      network_rx: 1,
      network_tx: 2,
      blk_read: 3,
      blk_write: 4,
      internal_token: "never-returned",
    })).toEqual({
      cpu_percent: 10.5,
      memory_usage: 10,
      memory_limit: 20,
      memory_percent: 50,
      network_rx: 1,
      network_tx: 2,
      blk_read: 3,
      blk_write: 4,
    });
  });
});

describe("Supervisor support-log redaction", () => {
  it("redacts representative credential forms before bounded output", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "password=hunter2hunter2",
      "access_token: \"long-secret-token-value\"",
      "GET /?api_key=query-secret-value HTTP/1.1",
      "connect https://alice:secret@example.test/path",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
      "normal diagnostic line",
    ].join("\n");
    const result = formatSupportLog(text, { source: "supervisor", lines: 50 });

    expect(result.meta.redactions).toBeGreaterThanOrEqual(6);
    expect(result.data.log).toContain("normal diagnostic line");
    for (const secret of ["abcdefghijklmnopqrstuvwxyz", "hunter2hunter2", "long-secret-token-value", "query-secret-value", "alice:secret", "signaturevalue"]) {
      expect(result.data.log).not.toContain(secret);
    }
  });

  it("uses a strict runtime line cap even when the caller supplies an invalid value", () => {
    const text = Array.from({ length: DEFAULT_LOG_LINES + 10 }, (_, index) => `line-${index}`).join("\n");
    const result = formatSupportLog(text, { source: "core", lines: "not-a-number" });

    expect(result.meta.applied_lines).toBe(DEFAULT_LOG_LINES);
    expect(result.meta.returned_lines).toBe(DEFAULT_LOG_LINES);
    expect(result.data.log).not.toContain("line-0");
    expect(result.data.log).toContain(`line-${DEFAULT_LOG_LINES + 9}`);
  });

  it("enforces the character ceiling after redaction", () => {
    const result = formatSupportLog(`password=large-secret-value\n${"x".repeat(MAX_LOG_CHARS + 500)}`, { source: "core", lines: 2 });

    expect(result.meta.truncated_by_chars).toBe(true);
    expect(result.data.log.length).toBeLessThanOrEqual(MAX_LOG_CHARS);
    expect(result.data.log).toContain("<log truncated");
    expect(result.data.log).not.toContain("large-secret-value");
  });

  it("caps list limits at the documented maximum", () => {
    const data = projectResolution({ issues: Array.from({ length: MAX_LIST_LIMIT + 1 }, () => ({ type: "test" })) }, { limit: MAX_LIST_LIMIT + 99 });
    expect(data.issues.returned).toBe(MAX_LIST_LIMIT);
    expect(data.issues.truncated).toBe(true);
  });

  it("reports redaction counts for direct redactor use", () => {
    const result = redactSensitiveText("SUPERVISOR_TOKEN=very-secret-token-value");
    expect(result).toEqual({ text: "SUPERVISOR_TOKEN=<redacted>", redactions: 1 });
  });
});
