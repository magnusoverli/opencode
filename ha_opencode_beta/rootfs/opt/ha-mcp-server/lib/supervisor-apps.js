// Supervisor V2 is feature-flagged. Keep application calls working on current
// V1-only installations while preferring V2 whenever the Supervisor exposes it.

export const SUPERVISOR_APPS_FALLBACK_RETRY_MS = 15 * 60 * 1000;

function normalizeApps(data, key, endpoint) {
  if (!data || !Array.isArray(data[key])) {
    throw new Error(`Supervisor response from ${endpoint} did not contain an '${key}' array`);
  }
  return data[key];
}

function appPath(version, operation, slug) {
  if (typeof slug !== "string" || slug.length === 0) {
    throw new Error("Supervisor app slug is required");
  }

  const encodedSlug = encodeURIComponent(slug);
  const prefix = version === "v2" ? "/v2" : "";
  const collection = version === "v2" ? "apps" : "addons";

  switch (operation) {
    case "info":
      return `${prefix}/${collection}/${encodedSlug}/info`;
    case "changelog":
      return `${prefix}/store/${collection}/${encodedSlug}/changelog`;
    case "update":
      return `${prefix}/store/${collection}/${encodedSlug}/update`;
    default:
      throw new Error(`Unknown Supervisor app operation '${operation}'`);
  }
}

/**
 * Resolve the Supervisor's application API version and normalize its list
 * response. V2 is available only when SUPERVISOR_V2_API is enabled. A missing
 * V2 list route is the sole fallback condition: a 404 from an app-specific
 * route may instead mean that the requested app does not exist.
 */
export function createSupervisorAppsClient({
  request,
  fallbackRetryMs = SUPERVISOR_APPS_FALLBACK_RETRY_MS,
  now = () => Date.now(),
  onFallback = null,
  onRecovered = null,
} = {}) {
  if (typeof request !== "function") {
    throw new Error("A Supervisor request function is required");
  }

  let version = null;
  let fellBackAt = null;
  let fallbackReported = false;
  let probePromise = null;

  function maybeRetryV2() {
    if (version !== "v1" || fellBackAt === null || !(fallbackRetryMs > 0)) return;
    if (now() - fellBackAt < fallbackRetryMs) return;
    version = null;
    fellBackAt = null;
  }

  async function probe() {
    try {
      const data = await request("/v2/apps");
      const apps = normalizeApps(data, "apps", "/v2/apps");
      const recovered = fallbackReported;
      version = "v2";
      fellBackAt = null;
      fallbackReported = false;
      if (recovered) onRecovered?.({ endpoint: "/v2/apps" });
      return { version, apps };
    } catch (error) {
      if (error?.status !== 404) throw error;

      version = "v1";
      fellBackAt = now();
      if (!fallbackReported) {
        fallbackReported = true;
        onFallback?.({
          from: "/v2/apps",
          to: "/addons",
          reason: "v2_app_api_unavailable",
          retry_in_ms: fallbackRetryMs > 0 ? fallbackRetryMs : null,
        });
      }
      return { version, apps: null };
    }
  }

  async function selectVersion() {
    maybeRetryV2();
    if (version) return { version, apps: null };

    if (!probePromise) {
      probePromise = probe().finally(() => {
        probePromise = null;
      });
    }
    return probePromise;
  }

  async function requestFor(operation, slug, method = "GET", body = null, timeoutMs) {
    const selected = await selectVersion();
    return request(appPath(selected.version, operation, slug), method, body, timeoutMs);
  }

  return {
    get version() {
      return version;
    },

    async list() {
      const selected = await selectVersion();
      if (selected.version === "v2" && selected.apps) return selected.apps;

      const endpoint = selected.version === "v2" ? "/v2/apps" : "/addons";
      const key = selected.version === "v2" ? "apps" : "addons";
      return normalizeApps(await request(endpoint), key, endpoint);
    },

    info(slug) {
      return requestFor("info", slug);
    },

    changelog(slug) {
      return requestFor("changelog", slug);
    },

    update(slug, body, timeoutMs) {
      return requestFor("update", slug, "POST", body, timeoutMs);
    },
  };
}
