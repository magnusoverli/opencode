export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LOG_LINES = 100;
export const MAX_LOG_LINES = 500;
export const MAX_LOG_CHARS = 20_000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeText(value, maxLength = 160) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return redactSensitiveText(trimmed.slice(0, maxLength)).text;
}

function flag(value) {
  return typeof value === "boolean" ? value : null;
}

function countBy(records, field = "type") {
  const counts = new Map();
  for (const record of asArray(records)) {
    const value = safeText(record?.[field], 80) || "unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ value, count }));
}

function clampInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function dateMillis(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ageDays(value, now) {
  const timestamp = dateMillis(value);
  if (timestamp === null) return null;
  return Math.max(0, Math.floor((now - timestamp) / (24 * 60 * 60 * 1000)));
}

function projectResolutionRecord(record) {
  return {
    type: safeText(record?.type, 100),
    context: safeText(record?.context, 100),
    auto: flag(record?.auto),
    has_reference: Boolean(record?.reference),
    has_reference_extra: Boolean(record?.reference_extra),
  };
}

function projectJobs(jobs) {
  const records = asArray(jobs);
  return {
    total: records.length,
    active: records.filter((job) => !job?.done).length,
    completed: records.filter((job) => job?.done).length,
    failed: records.filter((job) => job?.done && asArray(job?.errors).length > 0).length,
  };
}

/** Return a privacy-preserving installation-health summary. */
export function projectSupervisorHealth({ supervisor, host, network, resolution, jobs } = {}) {
  const interfaces = asArray(network?.interfaces).map((item) => ({
    interface: safeText(item?.interface, 80),
    type: safeText(item?.type, 40),
    enabled: flag(item?.enabled),
    connected: flag(item?.connected),
    primary: flag(item?.primary),
  }));

  return {
    supervisor: {
      version: safeText(supervisor?.version, 80),
      version_latest: safeText(supervisor?.version_latest, 80),
      update_available: flag(supervisor?.update_available),
      channel: safeText(supervisor?.channel, 40),
      arch: safeText(supervisor?.arch, 40),
      supported: flag(supervisor?.supported),
      healthy: flag(supervisor?.healthy),
      timezone: safeText(supervisor?.timezone, 80),
      logging: safeText(supervisor?.logging, 40),
    },
    host: {
      operating_system: safeText(host?.operating_system, 160),
      kernel: safeText(host?.kernel, 160),
      deployment: safeText(host?.deployment, 80),
      virtualization: safeText(host?.virtualization, 80),
      chassis: safeText(host?.chassis, 80),
      timezone: safeText(host?.timezone, 80),
      time_synchronized: flag(host?.dt_synchronized),
      ntp_enabled: flag(host?.use_ntp),
      disk_free: finiteNumber(host?.disk_free),
      disk_total: finiteNumber(host?.disk_total),
      disk_used: finiteNumber(host?.disk_used),
      disk_life_time: finiteNumber(host?.disk_life_time),
    },
    connectivity: {
      host_internet: flag(network?.host_internet),
      supervisor_internet: flag(network?.supervisor_internet),
      interfaces_total: interfaces.length,
      interfaces_connected: interfaces.filter((item) => item.connected).length,
      interfaces_primary: interfaces.filter((item) => item.primary).length,
      interfaces: interfaces.slice(0, 20),
      interfaces_truncated: interfaces.length > 20,
    },
    resolution: {
      issues: asArray(resolution?.issues).length,
      unhealthy: asArray(resolution?.unhealthy).length,
      unsupported: asArray(resolution?.unsupported).length,
      suggestions: asArray(resolution?.suggestions).length,
      issue_types: countBy(resolution?.issues),
    },
    jobs: projectJobs(jobs?.jobs),
  };
}

/** Return bounded Resolution evidence without references or error payloads. */
export function projectResolution(info, { limit = DEFAULT_LIST_LIMIT } = {}) {
  const cappedLimit = clampInteger(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const projectRecords = (records) => {
    const all = asArray(records);
    return {
      total: all.length,
      returned: Math.min(all.length, cappedLimit),
      truncated: all.length > cappedLimit,
      items: all.slice(0, cappedLimit).map(projectResolutionRecord),
    };
  };

  const issues = projectRecords(info?.issues);
  const unhealthy = projectRecords(info?.unhealthy);
  const unsupported = projectRecords(info?.unsupported);
  const suggestions = projectRecords(info?.suggestions);
  const checks = asArray(info?.checks);

  const nextSteps = [];
  if (issues.total || unhealthy.total || unsupported.total) {
    nextSteps.push("Review the reported Supervisor Resolution items before applying any suggestion.");
  }
  if (suggestions.total) {
    nextSteps.push("Review each suggestion's impact and request explicit approval before applying it.");
  }
  if (!nextSteps.length) nextSteps.push("No Supervisor Resolution issues were reported.");

  return {
    issues,
    unhealthy,
    unsupported,
    suggestions,
    checks: {
      total: checks.length,
      returned: Math.min(checks.length, cappedLimit),
      truncated: checks.length > cappedLimit,
      items: checks.slice(0, cappedLimit).map((check) => ({
        slug: safeText(check?.slug, 100),
        enabled: flag(check?.enabled),
      })),
    },
    recommendations: nextSteps,
  };
}

/** Return a bounded backup inventory without storage paths or repository data. */
export function projectBackupPosture(info, { limit = DEFAULT_LIST_LIMIT, now = Date.now() } = {}) {
  const cappedLimit = clampInteger(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const backups = asArray(info?.backups)
    .slice()
    .sort((left, right) => (dateMillis(right?.date) || 0) - (dateMillis(left?.date) || 0));

  return {
    days_until_stale: finiteNumber(info?.days_until_stale),
    total: backups.length,
    returned: Math.min(backups.length, cappedLimit),
    truncated: backups.length > cappedLimit,
    newest_age_days: backups.length ? ageDays(backups[0]?.date, now) : null,
    backups: backups.slice(0, cappedLimit).map((backup) => ({
      slug: safeText(backup?.slug, 120),
      date: safeText(backup?.date, 80),
      age_days: ageDays(backup?.date, now),
      type: safeText(backup?.type, 80),
      size_bytes: finiteNumber(backup?.size_bytes),
      protected: flag(backup?.protected),
      compressed: flag(backup?.compressed),
      includes_homeassistant: flag(backup?.content?.homeassistant),
      app_count: asArray(backup?.content?.addons).length,
      folder_count: asArray(backup?.content?.folders).length,
      location_count: asArray(backup?.locations).length,
    })),
  };
}

/** Strip credential-bearing components from a repository URL or source string. */
export function sanitizeRepositorySource(value) {
  const source = safeText(value, 500);
  if (!source) return null;

  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return source
      .replace(/\/\/[^/@\s]+@/g, "//<redacted>@")
      .replace(/[?#].*$/, "");
  }
}

/** Return a bounded software-source audit without app descriptions or raw URLs. */
export function projectStoreAudit(store, { limit = DEFAULT_LIST_LIMIT } = {}) {
  const cappedLimit = clampInteger(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const apps = asArray(store?.addons);
  const repositories = asArray(store?.repositories);
  const orderedApps = apps.slice().sort((left, right) => {
    const priority = Number(Boolean(right?.update_available)) - Number(Boolean(left?.update_available));
    if (priority) return priority;
    return String(left?.name || left?.slug || "").localeCompare(String(right?.name || right?.slug || ""));
  });

  return {
    apps: {
      total: apps.length,
      installed: apps.filter((app) => app?.installed).length,
      updates_available: apps.filter((app) => app?.update_available).length,
      unavailable: apps.filter((app) => app?.available === false).length,
      returned: Math.min(orderedApps.length, cappedLimit),
      truncated: orderedApps.length > cappedLimit,
      items: orderedApps.slice(0, cappedLimit).map((app) => ({
        slug: safeText(app?.slug, 120),
        name: safeText(app?.name, 160),
        repository: safeText(app?.repository, 120),
        stage: safeText(app?.stage, 80),
        installed: flag(app?.installed),
        available: flag(app?.available),
        update_available: flag(app?.update_available),
        version: safeText(app?.version, 100),
        version_latest: safeText(app?.version_latest, 100),
      })),
    },
    repositories: {
      total: repositories.length,
      returned: Math.min(repositories.length, cappedLimit),
      truncated: repositories.length > cappedLimit,
      items: repositories.slice(0, cappedLimit).map((repository) => ({
        slug: safeText(repository?.slug, 120),
        name: safeText(repository?.name, 160),
        maintainer: safeText(repository?.maintainer, 160),
        source: sanitizeRepositorySource(repository?.source || repository?.url),
      })),
    },
  };
}

/** Normalize the low-frequency stats model without exposing arbitrary fields. */
export function projectSupervisorMetrics(stats) {
  return {
    cpu_percent: finiteNumber(stats?.cpu_percent),
    memory_usage: finiteNumber(stats?.memory_usage),
    memory_limit: finiteNumber(stats?.memory_limit),
    memory_percent: finiteNumber(stats?.memory_percent),
    network_rx: finiteNumber(stats?.network_rx),
    network_tx: finiteNumber(stats?.network_tx),
    blk_read: finiteNumber(stats?.blk_read),
    blk_write: finiteNumber(stats?.blk_write),
  };
}

function redact(text, pattern, replacement, state) {
  return text.replace(pattern, (...args) => {
    state.count += 1;
    return typeof replacement === "function" ? replacement(...args) : replacement;
  });
}

/** Redact common credential formats from a diagnostic text payload. */
export function redactSensitiveText(value) {
  const state = { count: 0 };
  let text = String(value ?? "");
  text = redact(text, /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "<redacted private key>", state);
  text = redact(text, /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi, "Bearer <redacted>", state);
  text = redact(text, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<redacted jwt>", state);
  text = redact(text, /\b(authorization\s*[:=]\s*)(?:Bearer\s+)?\S+/gi, (match, prefix) => `${prefix}<redacted>`, state);
  text = redact(text, /([?&](?:access_?token|api_?key|token|password|secret)=[^&\s]+)/gi, (match) => {
    const separator = match.indexOf("=");
    return `${match.slice(0, separator + 1)}<redacted>`;
  }, state);
  text = redact(text, /\b((?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|supervisor_token)\s*[:=]\s*["']?)[^\s"',;}]+/gi, (match, prefix) => `${prefix}<redacted>`, state);
  text = redact(text, /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, (match, scheme) => `${scheme}<redacted>@`, state);
  return { text, redactions: state.count };
}

/** Bound and redact an untrusted journal response before it reaches the model. */
export function formatSupportLog(text, { source, addonSlug = null, lines = DEFAULT_LOG_LINES } = {}) {
  const requestedLines = clampInteger(lines, DEFAULT_LOG_LINES, MAX_LOG_LINES);
  const allLines = String(text ?? "").split("\n");
  if (allLines.at(-1) === "") allLines.pop();
  const selected = allLines.slice(-requestedLines);
  const redacted = redactSensitiveText(selected.join("\n"));
  const truncatedByChars = redacted.text.length > MAX_LOG_CHARS;
  const marker = `\n<log truncated to ${MAX_LOG_CHARS} characters>`;
  const safeLog = truncatedByChars
    ? `${redacted.text.slice(0, MAX_LOG_CHARS - marker.length)}${marker}`
    : redacted.text;

  return {
    summary: `Returned ${selected.length} redacted ${source} log lines`,
    data: {
      source,
      ...(addonSlug ? { addon_slug: addonSlug } : {}),
      log: safeLog,
    },
    meta: {
      requested_lines: lines,
      applied_lines: requestedLines,
      returned_lines: selected.length,
      server_limited: null,
      redactions: redacted.redactions,
      truncated: allLines.length > selected.length || truncatedByChars,
      truncated_by_chars: truncatedByChars,
    },
  };
}
