#!/usr/bin/env node
/**
 * Home Assistant MCP Server for OpenCode (Safe Config Edition v2.6)
 * 
 * A cutting-edge MCP server providing deep integration with Home Assistant.
 * Implements the latest MCP specification (2025-06-18) features:
 * 
 * - Structured tool output with outputSchema
 * - Tool annotations (destructive, idempotent, etc.)
 * - Human-readable title fields
 * - Resource links in tool results
 * - Logging capability for debugging
 * - Content annotations (audience/priority)
 * - Live documentation fetching
 * - Breaking changes awareness
 * - Deprecation pattern detection (shared DB with remote GitHub updates)
 * - Real-time update progress monitoring
 * - ESPHome build and flash integration
 * - Visual firmware update monitoring with timeline
 * - Safe config writing with automatic validation and backup/restore
 * - Jinja2 template pre-validation through HA's engine
 * - Structural YAML validation for automations, scripts, templates
 * - HA Repairs API integration (instance-specific deprecation warnings)
 * - HA Alerts feed integration (global integration issue awareness)
 * 
 * TOOLS (33):
 * - Entity state management (get, search, history)
 * - Service calls with intelligent targeting
 * - Configuration validation and safe writing
 * - Jinja2 template validation through HA's engine
 * - Calendar, logbook, and history access
 * - Anomaly detection and suggestions
 * - Documentation fetching and syntax checking
 * - Update management with real-time progress monitoring
 * - ESPHome device management, compile, and upload
 * 
 * RESOURCES (9 + 4 templates):
 * - Live entity states by domain
 * - Automations, scripts, and scenes
 * - Area and device mappings
 * - System configuration
 * 
 * PROMPTS (6):
 * - Troubleshooting workflows
 * - Automation creation guides
 * - Energy optimization analysis
 * - Scene building assistance
 * 
 * Environment variables:
 * - SUPERVISOR_TOKEN: The Home Assistant Supervisor token (auto-provided in app)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourceTemplatesRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { execFile } from "child_process";
import { dirname, join, resolve, isAbsolute, normalize } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SUPERVISOR_API = "http://supervisor/core/api";
const HA_CONFIG_DIR = "/homeassistant";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_ACCESS_TOKEN = process.env.HA_ACCESS_TOKEN;   // Long-lived token for direct HA Core calls

// Home Assistant documentation base URLs
const HA_DOCS_BASE = "https://www.home-assistant.io";
const HA_INTEGRATIONS_URL = `${HA_DOCS_BASE}/integrations`;
const HA_BLOG_URL = `${HA_DOCS_BASE}/blog`;

if (!SUPERVISOR_TOKEN) {
  console.error("Error: SUPERVISOR_TOKEN environment variable is required");
  process.exit(1);
}

// ============================================================================
// LOGGING SYSTEM
// ============================================================================

let currentLogLevel = "info";
const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];

function getLogLevelIndex(level) {
  return LOG_LEVELS.indexOf(level);
}

function shouldLog(level) {
  return getLogLevelIndex(level) >= getLogLevelIndex(currentLogLevel);
}

function sendLog(level, logger, data) {
  if (shouldLog(level)) {
    // Log notifications are sent via server.notification
    // For now, we log to stderr which the client can capture
    console.error(JSON.stringify({
      type: "log",
      level,
      logger,
      data,
      timestamp: new Date().toISOString(),
    }));
  }
}

// ============================================================================
// HOME ASSISTANT API HELPERS
// ============================================================================

/**
 * Call Home Assistant via Supervisor API proxy
 * Used for most endpoints that are proxied through supervisor
 */
async function callHA(endpoint, method = "GET", body = null) {
  sendLog("debug", "ha-api", { action: "request", endpoint, method });
  
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${SUPERVISOR_TOKEN}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${SUPERVISOR_API}${endpoint}`, options);
  
  if (!response.ok) {
    const text = await response.text();
    sendLog("error", "ha-api", { action: "error", endpoint, status: response.status, error: text });
    throw new Error(`HA API error (${response.status}): ${text}`);
  }

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    const result = await response.json();
    sendLog("debug", "ha-api", { action: "response", endpoint, success: true });
    return result;
  }
  return response.text();
}

/**
 * Call Home Assistant Supervisor API directly
 * Used for add-on management, updates, jobs, and system operations
 */
async function callSupervisor(endpoint, method = "GET", body = null) {
  sendLog("debug", "supervisor-api", { action: "request", endpoint, method });
  
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${SUPERVISOR_TOKEN}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`http://supervisor${endpoint}`, options);
  
  if (!response.ok) {
    const text = await response.text();
    sendLog("error", "supervisor-api", { action: "error", endpoint, status: response.status, error: text });
    throw new Error(`Supervisor API error (${response.status}): ${text}`);
  }

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    const result = await response.json();
    sendLog("debug", "supervisor-api", { action: "response", endpoint, success: true });
    // Supervisor API wraps data in { result: "ok", data: {...} }
    return result.data !== undefined ? result.data : result;
  }
  return response.text();
}

// ============================================================================
// ESPHOME INTEGRATION HELPERS
// ============================================================================

/**
 * Discover ESPHome add-on and return its URL via the Supervisor ingress proxy.
 *
 * ESPHome (since ~2026.2.x) no longer exposes the dashboard on a TCP port.
 * The dashboard binds to a Unix socket, fronted by nginx with IP-based access
 * rules that block requests from other addon containers.
 *
 * We discover HA Core's real LAN URL from /api/config (internal_url), create
 * an ingress session via WebSocket (the only method that works), and route
 * requests through HA Core's ingress proxy using a long-lived access token.
 * This is the exact same path the external CLI uses.
 *
 * Returns { ok: true, ...result } on success,
 *   or { ok: false, error: "...", diagnostics: {...} } on failure.
 */
async function discoverESPHome() {
  const diag = {
    steps: [],
    addonFound: false,
    addonSlug: null,
    addonState: null,
    ingressEntry: null,
    hasAccessToken: !!HA_ACCESS_TOKEN,
    internalUrl: null,
    externalUrl: null,
    haCoreUrl: null,
    urlSource: null,
    networkFallback: null,
    wsSessionResult: null,
  };
  
  function step(name, status, detail = null) {
    diag.steps.push({ name, status, detail });
    sendLog("debug", "esphome", { action: "discover_step", name, status, detail });
  }

  try {
    // Step 1: Find ESPHome addon
    let addonsInfo;
    try {
      addonsInfo = await callSupervisor("/addons");
      step("fetch_addons", "ok", { addonCount: addonsInfo.addons?.length });
    } catch (e) {
      step("fetch_addons", "error", e.message);
      return { ok: false, error: `Failed to list addons: ${e.message}`, diagnostics: diag };
    }
    
    const esphome = addonsInfo.addons?.find(a => 
      a.slug.includes("esphome") && a.installed
    );
    
    if (!esphome) {
      step("find_esphome", "error", "No addon with 'esphome' in slug and installed=true");
      // Include available slugs for debugging
      const slugs = (addonsInfo.addons || [])
        .filter(a => a.slug.includes("esphome"))
        .map(a => ({ slug: a.slug, installed: a.installed, state: a.state }));
      diag.esphomeSlugs = slugs;
      return { ok: false, error: "ESPHome addon not found in addon list.", diagnostics: diag };
    }
    
    diag.addonFound = true;
    diag.addonSlug = esphome.slug;
    step("find_esphome", "ok", { slug: esphome.slug });
    
    // Step 2: Get addon info
    let info;
    try {
      info = await callSupervisor(`/addons/${esphome.slug}/info`);
      diag.addonState = info.state;
      diag.ingressEntry = info.ingress_entry;
      step("addon_info", "ok", { state: info.state, version: info.version, ingress_entry: info.ingress_entry });
    } catch (e) {
      step("addon_info", "error", e.message);
      return { ok: false, error: `Failed to get addon info for ${esphome.slug}: ${e.message}`, diagnostics: diag };
    }
    
    if (!info.ingress_entry) {
      step("ingress_entry", "error", "ingress_entry is null/empty");
      return { ok: false, error: "ESPHome addon has no ingress_entry configured.", diagnostics: diag };
    }
    step("ingress_entry", "ok", info.ingress_entry);
    
    // Step 3: Check access token
    if (!HA_ACCESS_TOKEN) {
      step("access_token", "error", "HA_ACCESS_TOKEN env var is not set");
      return { ok: false, error: "ESPHome ingress requires a long-lived access token. " +
        "Create one at Profile → Long-Lived Access Tokens in the HA UI, " +
        "then paste it into the addon's 'access_token' configuration option.", diagnostics: diag };
    }
    step("access_token", "ok");
    
    // Step 4: Discover HA Core URL
    let haCoreUrl;
    let haConfig;
    try {
      haConfig = await callHA("/config");
      diag.internalUrl = haConfig.internal_url || null;
      diag.externalUrl = haConfig.external_url || null;
      step("ha_config", "ok", { internal_url: diag.internalUrl, external_url: diag.externalUrl });
    } catch (e) {
      step("ha_config", "error", e.message);
      return { ok: false, error: `Failed to get HA config: ${e.message}`, diagnostics: diag };
    }
    
    haCoreUrl = (haConfig.internal_url || haConfig.external_url || "").replace(/\/+$/, "");
    
    if (haCoreUrl) {
      diag.urlSource = "ha_config";
    } else {
      // internal_url is "automatic" (null) — discover from Supervisor APIs
      step("url_fallback", "started", "internal_url and external_url are both null, trying network discovery");
      try {
        const [coreInfo, networkInfo] = await Promise.all([
          callSupervisor("/core/info"),
          callSupervisor("/network/info"),
        ]);
        
        const port = coreInfo.port || 8123;
        const ssl = coreInfo.ssl || false;
        const protocol = ssl ? "https" : "http";
        
        diag.networkFallback = { port, ssl, interfaces: [] };
        
        // Find the primary connected interface and extract its LAN IP
        let hostIp = null;
        if (networkInfo.interfaces) {
          for (const iface of networkInfo.interfaces) {
            diag.networkFallback.interfaces.push({
              name: iface.interface,
              primary: iface.primary,
              connected: iface.connected,
              ipv4_addresses: iface.ipv4?.address || [],
            });
          }
          const primary = networkInfo.interfaces.find(i => i.primary && i.connected);
          const iface = primary || networkInfo.interfaces.find(i => i.connected);
          if (iface?.ipv4?.address?.[0]) {
            hostIp = iface.ipv4.address[0].split("/")[0];
          }
        }
        
        if (hostIp) {
          haCoreUrl = `${protocol}://${hostIp}:${port}`;
          diag.urlSource = "network_fallback";
          step("url_fallback", "ok", { url: haCoreUrl, ip: hostIp, port, ssl });
        } else {
          step("url_fallback", "error", "Could not find a connected interface with an IPv4 address");
        }
      } catch (e) {
        step("url_fallback", "error", e.message);
      }
    }
    
    diag.haCoreUrl = haCoreUrl;
    
    if (!haCoreUrl) {
      return { ok: false, error: "Could not determine HA Core URL. " +
        "Set internal_url in Settings → System → Network, " +
        "or ensure the host has a connected network interface.", diagnostics: diag };
    }
    step("ha_core_url", "ok", { url: haCoreUrl, source: diag.urlSource });
    
    // Step 5: Create ingress session via WebSocket
    let ingressSession;
    try {
      ingressSession = await createIngressSessionViaWebSocket(haCoreUrl, HA_ACCESS_TOKEN);
      if (ingressSession) {
        diag.wsSessionResult = "ok";
        step("ws_session", "ok");
      } else {
        diag.wsSessionResult = "returned_null";
        step("ws_session", "error", "createIngressSessionViaWebSocket returned null (auth failed or no session in response)");
        return { ok: false, error: `WebSocket ingress session creation returned null. ` +
          `Connected to ${haCoreUrl.replace(/^http/, "ws")}/api/websocket but did not get a session token. ` +
          `Check that the access_token is valid.`, diagnostics: diag };
      }
    } catch (e) {
      diag.wsSessionResult = `error: ${e.message}`;
      step("ws_session", "error", e.message);
      return { ok: false, error: `WebSocket ingress session creation failed: ${e.message}. ` +
        `Tried connecting to ${haCoreUrl.replace(/^http/, "ws")}/api/websocket`, diagnostics: diag };
    }
    
    // Step 6: Build final URL
    const url = `${haCoreUrl}/api/hassio_ingress/${info.ingress_entry}`;
    step("final_url", "ok", url);
    
    const result = {
      ok: true,
      slug: esphome.slug,
      name: esphome.name,
      url,
      ingressSession,
      state: info.state,
      version: info.version,
      diagnostics: diag,
    };
    
    sendLog("debug", "esphome", { action: "discover", result: { ...result, ingressSession: "[redacted]" } });
    return result;
  } catch (error) {
    step("unexpected", "error", error.message);
    return { ok: false, error: `Unexpected error in discoverESPHome: ${error.message}`, diagnostics: diag };
  }
}

/**
 * Create an ingress session via HA Core's WebSocket API.
 * This is the ONLY method that works — REST-based session creation is rejected
 * by the Supervisor regardless of token type.  The WebSocket `supervisor/api`
 * command lets HA Core make the Supervisor call with its own credentials.
 *
 * @param {string} haCoreUrl - HA Core URL (e.g. http://192.168.1.100:8123)
 * @param {string} token - Long-lived access token
 * @returns {Promise<string|null>} Ingress session token, or null on failure
 */
async function createIngressSessionViaWebSocket(haCoreUrl, token) {
  return new Promise((resolve, reject) => {
    const wsUrl = haCoreUrl.replace(/^http/, "ws") + "/api/websocket";
    sendLog("debug", "esphome", { action: "ws_session", url: wsUrl });

    const ws = new WebSocket(wsUrl);
    let msgId = 1;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket session creation timed out"));
    }, 15000);

    ws.on("open", () => {
      sendLog("debug", "esphome", { action: "ws_session_open" });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({ type: "auth", access_token: token }));
        } else if (msg.type === "auth_ok") {
          // Create ingress session via supervisor/api command
          const id = msgId++;
          ws.send(JSON.stringify({
            id,
            type: "supervisor/api",
            endpoint: "/ingress/session",
            method: "post",
          }));
        } else if (msg.type === "auth_invalid") {
          clearTimeout(timeout);
          ws.close();
          sendLog("error", "esphome", { action: "ws_session_auth_failed", message: msg.message });
          resolve(null);
        } else if (msg.type === "result") {
          clearTimeout(timeout);
          ws.close();
          if (msg.success && msg.result?.session) {
            sendLog("debug", "esphome", { action: "ws_session_created" });
            resolve(msg.result.session);
          } else {
            sendLog("error", "esphome", { action: "ws_session_failed", result: msg });
            resolve(null);
          }
        }
      } catch (e) {
        sendLog("error", "esphome", { action: "ws_session_parse_error", error: e.message });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      sendLog("error", "esphome", { action: "ws_session_error", error: err.message });
      reject(err);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Stream logs from ESPHome WebSocket endpoint
 * @param {string} baseUrl - ESPHome dashboard URL (Supervisor ingress URL)
 * @param {string} endpoint - WebSocket endpoint (e.g., "compile", "upload")
 * @param {object} params - Parameters to send (e.g., { configuration: "device.yaml" })
 * @param {function} onLine - Callback for each log line
 * @param {number} timeout - Timeout in milliseconds (default: 10 minutes for builds)
 * @param {string|null} ingressSession - Ingress session token for the Supervisor proxy
 * @returns {Promise<{success: boolean, code: number, logs: string[]}>}
 */
async function streamESPHomeLogs(baseUrl, endpoint, params, onLine = null, timeout = 600000, ingressSession = null) {
  return new Promise((resolve, reject) => {
    const logs = [];
    const startTime = Date.now();
    
    // Build WebSocket URL preserving the full path (important for ingress proxy)
    const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/" + endpoint;
    
    sendLog("debug", "esphome", { action: "ws_connect", url: wsUrl, params });
    
    // Pass ingress session cookie + Bearer token in the WebSocket upgrade handshake.
    // HA Core's ingress proxy requires the Bearer token for auth; the Supervisor
    // ingress handler requires the session cookie.
    const wsOptions = { headers: {} };
    if (ingressSession) {
      wsOptions.headers["Cookie"] = `ingress_session=${ingressSession}`;
    }
    if (HA_ACCESS_TOKEN) {
      wsOptions.headers["Authorization"] = `Bearer ${HA_ACCESS_TOKEN}`;
    }
    
    const ws = new WebSocket(wsUrl, wsOptions);
    
    // Set timeout
    const timeoutId = setTimeout(() => {
      ws.close();
      reject(new Error(`ESPHome operation timed out after ${timeout / 1000} seconds`));
    }, timeout);
    
    ws.on("open", () => {
      sendLog("debug", "esphome", { action: "ws_open", endpoint });
      ws.send(JSON.stringify({ type: "spawn", ...params }));
    });
    
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.event === "line") {
          logs.push(msg.data);
          if (onLine) onLine(msg.data);
        }
        
        if (msg.event === "exit") {
          clearTimeout(timeoutId);
          ws.close();
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);
          sendLog("info", "esphome", { 
            action: "ws_complete", 
            endpoint, 
            success: msg.code === 0, 
            code: msg.code,
            duration: `${duration}s`,
            logLines: logs.length 
          });
          resolve({ 
            success: msg.code === 0, 
            code: msg.code, 
            logs,
            duration: `${duration}s`
          });
        }
      } catch (parseError) {
        sendLog("warning", "esphome", { action: "ws_parse_error", error: parseError.message });
      }
    });
    
    ws.on("error", (error) => {
      clearTimeout(timeoutId);
      sendLog("error", "esphome", { action: "ws_error", endpoint, error: error.message });
      reject(new Error(`ESPHome WebSocket error: ${error.message}`));
    });
    
    ws.on("close", (code, reason) => {
      clearTimeout(timeoutId);
      // Only log unexpected closes (not our intentional closes)
      if (logs.length === 0) {
        sendLog("warning", "esphome", { action: "ws_close_unexpected", code, reason: reason?.toString() });
      }
    });
  });
}

/**
 * Get list of ESPHome devices via REST API
 * @param {string} esphomeUrl - ESPHome dashboard URL (Supervisor ingress URL)
 * @param {string|null} ingressSession - Ingress session token for the Supervisor proxy
 */
async function getESPHomeDevices(esphomeUrl, ingressSession = null) {
  const headers = {};
  if (ingressSession) {
    headers["Cookie"] = `ingress_session=${ingressSession}`;
  }
  // When routing through HA Core's ingress proxy, the Bearer token is
  // required for HA Core auth; the cookie is for the Supervisor's ingress.
  if (HA_ACCESS_TOKEN) {
    headers["Authorization"] = `Bearer ${HA_ACCESS_TOKEN}`;
  }
  const response = await fetch(`${esphomeUrl}/devices`, { headers });
  if (!response.ok) {
    throw new Error(`Failed to get ESPHome devices: ${response.status}`);
  }
  return await response.json();
}

// ============================================================================
// COMMON SCHEMAS FOR STRUCTURED OUTPUT
// ============================================================================

const SCHEMAS = {
  entityState: {
    type: "object",
    properties: {
      entity_id: { type: "string", description: "Entity identifier" },
      state: { type: "string", description: "Current state value" },
      friendly_name: { type: "string", description: "Human-readable name" },
      device_class: { type: "string", description: "Device classification" },
      last_changed: { type: "string", description: "ISO timestamp of last state change" },
      last_updated: { type: "string", description: "ISO timestamp of last update" },
    },
    required: ["entity_id", "state"],
  },
  
  entityStateArray: {
    type: "array",
    items: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        state: { type: "string" },
        friendly_name: { type: "string" },
        device_class: { type: "string" },
      },
      required: ["entity_id", "state"],
    },
  },
  
  searchResult: {
    type: "array",
    items: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        state: { type: "string" },
        friendly_name: { type: "string" },
        device_class: { type: "string" },
        score: { type: "number", description: "Search relevance score" },
      },
      required: ["entity_id", "state", "score"],
    },
  },
  
  entityDetails: {
    type: "object",
    properties: {
      entity_id: { type: "string" },
      friendly_name: { type: "string" },
      state: { type: "string" },
      domain: { type: "string" },
      device_class: { type: "string" },
      device_id: { type: "string" },
      area_id: { type: "string" },
      attributes: { type: "object" },
      related_entities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            entity_id: { type: "string" },
            friendly_name: { type: "string" },
            state: { type: "string" },
            relationship: { type: "string", enum: ["same_device", "same_area"] },
          },
        },
      },
    },
    required: ["entity_id", "state", "domain"],
  },
  
  serviceCallResult: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      domain: { type: "string" },
      service: { type: "string" },
      affected_entities: { type: "array", items: { type: "string" } },
    },
    required: ["success", "domain", "service"],
  },
  
  anomaly: {
    type: "object",
    properties: {
      entity_id: { type: "string" },
      reason: { type: "string" },
      severity: { type: "string", enum: ["info", "warning", "error"] },
    },
    required: ["entity_id", "reason", "severity"],
  },
  
  anomalyArray: {
    type: "array",
    items: {
      type: "object",
      properties: {
        entity_id: { type: "string" },
        reason: { type: "string" },
        severity: { type: "string", enum: ["info", "warning", "error"] },
      },
      required: ["entity_id", "reason", "severity"],
    },
  },
  
  suggestion: {
    type: "object",
    properties: {
      type: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      entities: { type: "array", items: { type: "string" } },
    },
    required: ["type", "title", "description"],
  },
  
  suggestionArray: {
    type: "array",
    items: {
      type: "object",
      properties: {
        type: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["type", "title", "description"],
    },
  },
  
  diagnostics: {
    type: "object",
    properties: {
      entity_id: { type: "string" },
      timestamp: { type: "string" },
      current_state: { type: "object" },
      checks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            check: { type: "string" },
            status: { type: "string", enum: ["ok", "info", "warning", "error"] },
            details: { type: "string" },
          },
        },
      },
      history_summary: { type: "object" },
      relationships: { type: "object" },
    },
    required: ["entity_id", "timestamp", "checks"],
  },
  
  configValidation: {
    type: "object",
    properties: {
      result: { type: "string", enum: ["valid", "invalid"] },
      errors: { type: "string" },
    },
    required: ["result"],
  },
  
  integrationDocs: {
    type: "object",
    properties: {
      integration: { type: "string", description: "Integration name" },
      url: { type: "string", description: "Documentation URL" },
      title: { type: "string", description: "Integration title" },
      description: { type: "string", description: "Integration description" },
      configuration: { type: "string", description: "Configuration section content" },
      ha_version: { type: "string", description: "Current HA version" },
      fetched_at: { type: "string", description: "Timestamp when docs were fetched" },
    },
    required: ["integration", "url"],
  },
  
  breakingChanges: {
    type: "object",
    properties: {
      ha_version: { type: "string", description: "Current Home Assistant version" },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            version: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            integration: { type: "string" },
            url: { type: "string" },
          },
        },
      },
    },
    required: ["ha_version", "changes"],
  },
  
  configSyntaxCheck: {
    type: "object",
    properties: {
      valid: { type: "boolean", description: "Whether the syntax appears valid" },
      deprecated: { type: "boolean", description: "Whether deprecated syntax was detected" },
      warnings: { 
        type: "array", 
        items: { type: "string" },
        description: "List of warnings about the configuration" 
      },
      suggestions: { 
        type: "array", 
        items: { type: "string" },
        description: "Suggestions for improving the configuration" 
      },
      docs_url: { type: "string", description: "URL to relevant documentation" },
    },
    required: ["valid", "deprecated", "warnings", "suggestions"],
  },
  
  safeWriteResult: {
    type: "object",
    properties: {
      success: { type: "boolean", description: "Whether the config was successfully written and validated" },
      dry_run: { type: "boolean", description: "Whether this was a dry-run (no file written)" },
      file_path: { type: "string", description: "The resolved file path" },
      validation_result: { type: "string", enum: ["valid", "invalid", "skipped"], description: "Result of HA core config validation" },
      validation_errors: { type: "string", description: "HA config validation error details" },
      deprecation_warnings: { type: "array", items: { type: "string" }, description: "Deprecation patterns detected" },
      template_results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            template: { type: "string" },
            status: { type: "string", enum: ["valid", "error", "skipped"] },
            error: { type: "string" },
          },
        },
        description: "Template validation results",
      },
      structural_issues: { type: "array", items: { type: "string" }, description: "Structural YAML issues found" },
      suggestions: { type: "array", items: { type: "string" }, description: "Improvement suggestions" },
      file_written: { type: "boolean", description: "Whether the file was actually written to disk" },
      backup_restored: { type: "boolean", description: "Whether the backup was restored due to validation failure" },
    },
    required: ["success", "dry_run", "validation_result"],
  },
  
  area: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
    required: ["id", "name"],
  },
  
  areaArray: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  },
};

// ============================================================================
// INTELLIGENCE LAYER - Semantic Analysis & Summaries
// ============================================================================

/**
 * Generate a human-readable summary of entity states
 */
function generateStateSummary(states) {
  const byDomain = {};
  const anomalies = [];
  const unavailable = [];
  
  for (const state of states) {
    const [domain] = state.entity_id.split(".");
    if (!byDomain[domain]) {
      byDomain[domain] = { count: 0, on: 0, off: 0, entities: [] };
    }
    byDomain[domain].count++;
    byDomain[domain].entities.push(state);
    
    if (state.state === "on") byDomain[domain].on++;
    if (state.state === "off") byDomain[domain].off++;
    if (state.state === "unavailable" || state.state === "unknown") {
      unavailable.push(state.entity_id);
    }
    
    // Detect anomalies
    const anomaly = detectAnomaly(state);
    if (anomaly) anomalies.push(anomaly);
  }
  
  const lines = ["## Home Assistant State Summary\n"];
  
  // Domain overview
  lines.push("### By Domain");
  for (const [domain, info] of Object.entries(byDomain).sort((a, b) => b[1].count - a[1].count)) {
    let detail = `${info.count} entities`;
    if (info.on > 0 || info.off > 0) {
      detail += ` (${info.on} on, ${info.off} off)`;
    }
    lines.push(`- **${domain}**: ${detail}`);
  }
  
  // Unavailable entities
  if (unavailable.length > 0) {
    lines.push("\n### Unavailable/Unknown Entities");
    for (const id of unavailable.slice(0, 10)) {
      lines.push(`- ${id}`);
    }
    if (unavailable.length > 10) {
      lines.push(`- ... and ${unavailable.length - 10} more`);
    }
  }
  
  // Anomalies
  if (anomalies.length > 0) {
    lines.push("\n### Potential Anomalies Detected");
    for (const a of anomalies.slice(0, 5)) {
      lines.push(`- **${a.entity_id}**: ${a.reason}`);
    }
  }
  
  return lines.join("\n");
}

/**
 * Detect anomalies in entity states
 */
function detectAnomaly(state) {
  const { entity_id, state: value, attributes } = state;
  const [domain] = entity_id.split(".");
  
  // Battery low
  if (attributes?.battery_level !== undefined && attributes.battery_level < 20) {
    return { entity_id, reason: `Low battery (${attributes.battery_level}%)`, severity: "warning" };
  }
  
  // Temperature sensors out of normal range
  if (domain === "sensor" && attributes?.device_class === "temperature") {
    const temp = parseFloat(value);
    if (!isNaN(temp)) {
      const unit = attributes.unit_of_measurement || "°C";
      const isCelsius = unit.includes("C");
      const normalMin = isCelsius ? -10 : 14;
      const normalMax = isCelsius ? 50 : 122;
      if (temp < normalMin || temp > normalMax) {
        return { entity_id, reason: `Unusual temperature: ${value}${unit}`, severity: "warning" };
      }
    }
  }
  
  // Humidity out of range
  if (domain === "sensor" && attributes?.device_class === "humidity") {
    const humidity = parseFloat(value);
    if (!isNaN(humidity) && (humidity < 10 || humidity > 95)) {
      return { entity_id, reason: `Unusual humidity: ${value}%`, severity: "warning" };
    }
  }
  
  // Door/window sensors open for extended period
  if ((domain === "binary_sensor") && 
      (attributes?.device_class === "door" || attributes?.device_class === "window") &&
      value === "on") {
    const lastChanged = new Date(state.last_changed);
    const hoursOpen = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60);
    if (hoursOpen > 4) {
      return { entity_id, reason: `Open for ${hoursOpen.toFixed(1)} hours`, severity: "info" };
    }
  }
  
  // Lights on during day (basic heuristic)
  if (domain === "light" && value === "on") {
    const hour = new Date().getHours();
    if (hour >= 10 && hour <= 16) {
      return { entity_id, reason: "Light on during daytime", severity: "info" };
    }
  }
  
  return null;
}

/**
 * Search entities semantically
 */
function searchEntities(states, query) {
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/);
  
  const results = states.map(state => {
    let score = 0;
    const searchText = [
      state.entity_id,
      state.attributes?.friendly_name || "",
      state.attributes?.device_class || "",
      state.state,
    ].join(" ").toLowerCase();
    
    for (const term of terms) {
      if (searchText.includes(term)) {
        score += 1;
        if ((state.attributes?.friendly_name || "").toLowerCase().includes(term)) {
          score += 2;
        }
        if (state.entity_id.includes(term)) {
          score += 1;
        }
      }
    }
    
    return { state, score };
  }).filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(r => ({
      entity_id: r.state.entity_id,
      state: r.state.state,
      friendly_name: r.state.attributes?.friendly_name,
      device_class: r.state.attributes?.device_class,
      score: r.score,
    }));
  
  return results;
}

/**
 * Get entity relationships
 */
async function getEntityRelationships(entityId) {
  const states = await callHA("/states");
  const entity = states.find(s => s.entity_id === entityId);
  
  if (!entity) {
    return { error: "Entity not found" };
  }
  
  const [domain] = entityId.split(".");
  const deviceId = entity.attributes?.device_id;
  const areaId = entity.attributes?.area_id;
  
  const related = states.filter(s => {
    if (s.entity_id === entityId) return false;
    if (deviceId && s.attributes?.device_id === deviceId) return true;
    if (areaId && s.attributes?.area_id === areaId) return true;
    return false;
  }).map(s => ({
    entity_id: s.entity_id,
    friendly_name: s.attributes?.friendly_name,
    state: s.state,
    relationship: s.attributes?.device_id === deviceId ? "same_device" : "same_area",
  }));
  
  return {
    entity_id: entityId,
    friendly_name: entity.attributes?.friendly_name,
    state: entity.state,
    domain,
    device_class: entity.attributes?.device_class,
    device_id: deviceId,
    area_id: areaId,
    attributes: entity.attributes,
    related_entities: related.slice(0, 10),
  };
}

/**
 * Generate automation suggestions
 */
function generateSuggestions(states) {
  const suggestions = [];
  
  const motionSensors = states.filter(s => 
    s.attributes?.device_class === "motion" || 
    s.entity_id.includes("motion")
  );
  const lights = states.filter(s => s.entity_id.startsWith("light."));
  
  for (const motion of motionSensors) {
    const areaId = motion.attributes?.area_id;
    if (areaId) {
      const areaLights = lights.filter(l => l.attributes?.area_id === areaId);
      if (areaLights.length > 0) {
        suggestions.push({
          type: "motion_light",
          title: "Motion-Activated Lighting",
          description: `Create automation: When ${motion.attributes?.friendly_name || motion.entity_id} detects motion, turn on ${areaLights.map(l => l.attributes?.friendly_name || l.entity_id).join(", ")}`,
          trigger_entity: motion.entity_id,
          action_entities: areaLights.map(l => l.entity_id),
        });
      }
    }
  }
  
  const openings = states.filter(s => 
    s.attributes?.device_class === "door" || 
    s.attributes?.device_class === "window"
  );
  if (openings.length > 0) {
    suggestions.push({
      type: "security_alert",
      title: "Security Alert Automation",
      description: `Create notification when doors/windows are left open for extended periods`,
      entities: openings.map(o => o.entity_id).slice(0, 5),
    });
  }
  
  const thermostats = states.filter(s => s.entity_id.startsWith("climate."));
  const tempSensors = states.filter(s => s.attributes?.device_class === "temperature");
  if (thermostats.length > 0 && tempSensors.length > 0) {
    suggestions.push({
      type: "climate_optimization",
      title: "Climate Optimization",
      description: "Create automations to adjust thermostat based on occupancy or outdoor temperature",
      climate_entities: thermostats.map(t => t.entity_id),
      sensor_entities: tempSensors.map(s => s.entity_id).slice(0, 3),
    });
  }
  
  const powerSensors = states.filter(s => 
    s.attributes?.device_class === "power" || 
    s.attributes?.device_class === "energy"
  );
  if (powerSensors.length > 0) {
    suggestions.push({
      type: "energy_monitoring",
      title: "Energy Usage Alerts",
      description: "Create alerts for unusual energy consumption patterns",
      entities: powerSensors.map(p => p.entity_id).slice(0, 5),
    });
  }
  
  return suggestions;
}

// ============================================================================
// DOCUMENTATION FETCHING HELPERS
// ============================================================================

/**
 * Fetch a URL and return its text content
 */
async function fetchUrl(url) {
  sendLog("debug", "docs", { action: "fetch", url });
  
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "HomeAssistant-MCP-Server/2.1.0",
        "Accept": "text/html,application/xhtml+xml,text/plain",
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return await response.text();
  } catch (error) {
    sendLog("error", "docs", { action: "fetch_error", url, error: error.message });
    throw error;
  }
}

/**
 * Extract meaningful content from HTML (basic extraction)
 */
function extractContentFromHtml(html) {
  // Remove script and style tags
  let content = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  content = content.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");
  content = content.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  
  // Extract title
  const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  
  // Extract meta description
  const descMatch = content.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const description = descMatch ? descMatch[1].trim() : "";
  
  // Try to find the main content area
  let mainContent = "";
  
  // Look for article or main content
  const articleMatch = content.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentMatch = content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  
  if (articleMatch) {
    mainContent = articleMatch[1];
  } else if (mainMatch) {
    mainContent = mainMatch[1];
  } else if (contentMatch) {
    mainContent = contentMatch[1];
  } else {
    // Fall back to body
    const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    mainContent = bodyMatch ? bodyMatch[1] : content;
  }
  
  // Convert common HTML to text/markdown
  mainContent = mainContent
    // Code blocks
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code[^>]*>([^<]+)<\/code>/gi, "`$1`")
    // Headings
    .replace(/<h1[^>]*>([^<]+)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([^<]+)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([^<]+)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([^<]+)<\/h4>/gi, "\n#### $1\n")
    // Lists
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    // Paragraphs and breaks
    .replace(/<p[^>]*>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Links - keep the text
    .replace(/<a[^>]*>([^<]+)<\/a>/gi, "$1")
    // Bold/strong
    .replace(/<strong[^>]*>([^<]+)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([^<]+)<\/b>/gi, "**$1**")
    // Italic/em
    .replace(/<em[^>]*>([^<]+)<\/em>/gi, "*$1*")
    .replace(/<i[^>]*>([^<]+)<\/i>/gi, "*$1*")
    // Remove remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  
  return { title, description, content: mainContent };
}

/**
 * Extract configuration section from documentation
 */
function extractConfigurationSection(content) {
  // Look for configuration-related sections
  const configPatterns = [
    /## Configuration[\s\S]*?(?=\n## |$)/i,
    /## YAML Configuration[\s\S]*?(?=\n## |$)/i,
    /### Configuration Variables[\s\S]*?(?=\n### |\n## |$)/i,
    /## Setup[\s\S]*?(?=\n## |$)/i,
  ];
  
  for (const pattern of configPatterns) {
    const match = content.match(pattern);
    if (match) {
      return match[0].trim();
    }
  }
  
  return null;
}

/**
 * Extract YAML examples from content
 */
function extractYamlExamples(content) {
  const examples = [];
  const codeBlockRegex = /```(?:yaml|YAML)?\n([\s\S]*?)```/g;
  
  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    examples.push(match[1].trim());
  }
  
  return examples;
}

/**
 * Load deprecation patterns from the shared JSON file (local bundled copy).
 * Returns compiled regex patterns ready for use.
 */
function loadLocalDeprecationPatterns() {
  try {
    const patternsPath = resolve(__dirname, "../shared/deprecation-patterns.json");
    const raw = readFileSync(patternsPath, "utf-8");
    const patterns = JSON.parse(raw);
    return patterns.map(p => ({
      ...p,
      pattern: new RegExp(p.pattern, p.flags || "m"),
    }));
  } catch (error) {
    console.error("Warning: Could not load local deprecation patterns:", error.message);
    return [];
  }
}

/**
 * GitHub URL for the latest deprecation patterns.
 * This allows pattern updates between add-on releases.
 */
const GITHUB_PATTERNS_URL = "https://raw.githubusercontent.com/magnusoverli/opencode/main/ha_opencode/rootfs/opt/shared/deprecation-patterns.json";

/**
 * HA Alerts JSON endpoint (public, no auth required).
 * Contains known integration issues with version ranges.
 */
const HA_ALERTS_URL = "https://alerts.home-assistant.io/alerts.json";

/**
 * Cache for dynamically loaded data with TTL.
 */
const dynamicCache = {
  patterns: { data: null, fetchedAt: 0 },
  alerts: { data: null, fetchedAt: 0 },
  repairs: { data: null, fetchedAt: 0 },
};
const DYNAMIC_CACHE_TTL = 3600000; // 1 hour

/**
 * Fetch the latest deprecation patterns from our GitHub repo.
 * Falls back to local bundled patterns if fetch fails.
 */
async function fetchRemoteDeprecationPatterns() {
  const now = Date.now();
  if (dynamicCache.patterns.data && (now - dynamicCache.patterns.fetchedAt) < DYNAMIC_CACHE_TTL) {
    return dynamicCache.patterns.data;
  }

  try {
    sendLog("debug", "patterns", { action: "fetch_remote", url: GITHUB_PATTERNS_URL });
    const response = await fetch(GITHUB_PATTERNS_URL, {
      headers: { "User-Agent": "HomeAssistant-MCP-Server/2.6.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const patterns = await response.json();
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error("Invalid patterns format");
    }
    
    const compiled = patterns.map(p => ({
      ...p,
      pattern: new RegExp(p.pattern, p.flags || "m"),
    }));
    
    dynamicCache.patterns.data = compiled;
    dynamicCache.patterns.fetchedAt = now;
    sendLog("info", "patterns", { action: "remote_loaded", count: compiled.length });
    return compiled;
  } catch (error) {
    sendLog("debug", "patterns", { action: "remote_fetch_failed", error: error.message });
    // Fall through to local patterns
    return null;
  }
}

/**
 * Fetch HA alerts from alerts.home-assistant.io (public JSON feed).
 * Returns alerts relevant to specific integrations with version info.
 */
async function fetchHAAlerts() {
  const now = Date.now();
  if (dynamicCache.alerts.data && (now - dynamicCache.alerts.fetchedAt) < DYNAMIC_CACHE_TTL) {
    return dynamicCache.alerts.data;
  }

  try {
    sendLog("debug", "alerts", { action: "fetch", url: HA_ALERTS_URL });
    const response = await fetch(HA_ALERTS_URL, {
      headers: { "User-Agent": "HomeAssistant-MCP-Server/2.6.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const alerts = await response.json();
    dynamicCache.alerts.data = alerts;
    dynamicCache.alerts.fetchedAt = now;
    sendLog("info", "alerts", { action: "loaded", count: alerts.length });
    return alerts;
  } catch (error) {
    sendLog("debug", "alerts", { action: "fetch_failed", error: error.message });
    return dynamicCache.alerts.data || [];
  }
}

/**
 * Query HA Core's repair issues via WebSocket API.
 * Returns deprecations and issues specific to this installation.
 */
async function fetchHARepairs() {
  const now = Date.now();
  if (dynamicCache.repairs.data && (now - dynamicCache.repairs.fetchedAt) < DYNAMIC_CACHE_TTL) {
    return dynamicCache.repairs.data;
  }

  return new Promise((resolve) => {
    const wsUrl = "ws://supervisor/core/websocket";
    let msgId = 1;
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (_) {}
      sendLog("debug", "repairs", { action: "ws_timeout" });
      resolve(dynamicCache.repairs.data || []);
    }, 5000);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (error) {
      clearTimeout(timeout);
      sendLog("debug", "repairs", { action: "ws_connect_failed", error: error.message });
      resolve(dynamicCache.repairs.data || []);
      return;
    }

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Step 1: HA sends auth_required
        if (msg.type === "auth_required") {
          ws.send(JSON.stringify({
            type: "auth",
            access_token: SUPERVISOR_TOKEN,
          }));
          return;
        }
        
        // Step 2: Auth result
        if (msg.type === "auth_ok") {
          ws.send(JSON.stringify({
            id: msgId++,
            type: "repairs/list_issues",
          }));
          return;
        }
        
        if (msg.type === "auth_invalid") {
          clearTimeout(timeout);
          ws.close();
          sendLog("debug", "repairs", { action: "auth_failed" });
          resolve(dynamicCache.repairs.data || []);
          return;
        }
        
        // Step 3: Repairs result
        if (msg.type === "result" && msg.success && msg.result?.issues) {
          clearTimeout(timeout);
          ws.close();
          const issues = msg.result.issues;
          dynamicCache.repairs.data = issues;
          dynamicCache.repairs.fetchedAt = now;
          sendLog("info", "repairs", { action: "loaded", count: issues.length });
          resolve(issues);
          return;
        }
        
        // Handle unexpected responses
        if (msg.type === "result" && !msg.success) {
          clearTimeout(timeout);
          ws.close();
          sendLog("debug", "repairs", { action: "api_error", error: msg.error });
          resolve(dynamicCache.repairs.data || []);
        }
      } catch (parseError) {
        // Ignore parse errors, wait for timeout
      }
    });

    ws.on("error", (error) => {
      clearTimeout(timeout);
      sendLog("debug", "repairs", { action: "ws_error", error: error.message });
      resolve(dynamicCache.repairs.data || []);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Get the best available deprecation patterns.
 * Tries remote (GitHub) first, falls back to local bundled patterns.
 * This is called lazily on first use, not at module load time.
 */
async function getDeprecationPatterns() {
  // Try remote patterns first (cached for 1 hour)
  const remote = await fetchRemoteDeprecationPatterns();
  if (remote && remote.length > 0) {
    return remote;
  }
  // Fall back to local bundled patterns
  return DEPRECATION_PATTERNS;
}

/**
 * Get relevant HA alerts for a specific integration.
 * Returns alerts that affect the given integration on the current HA version.
 */
async function getAlertsForIntegration(integration, haVersion = null) {
  const alerts = await fetchHAAlerts();
  if (!alerts || !Array.isArray(alerts)) return [];
  
  return alerts.filter(alert => {
    // Check if this alert affects the given integration
    const integrations = alert.integrations || [];
    const matchesIntegration = integrations.some(i => 
      i.package === integration || i.package === `homeassistant.components.${integration}`
    );
    if (!matchesIntegration) return false;
    
    // If we know the HA version, check version range
    if (haVersion && alert.homeassistant) {
      const minVersion = alert.homeassistant.min || alert.homeassistant.affected_from_version;
      const maxVersion = alert.homeassistant.max || alert.homeassistant.resolved_in_version;
      // Simple string comparison works for CalVer (YYYY.M.P)
      if (minVersion && haVersion < minVersion) return false;
      if (maxVersion && haVersion >= maxVersion) return false;
    }
    
    return true;
  });
}

/**
 * Get relevant repair issues for a set of integrations.
 * Filters repairs to only those matching the given domains.
 */
async function getRepairsForDomains(domains) {
  const repairs = await fetchHARepairs();
  if (!repairs || !Array.isArray(repairs)) return [];
  
  if (!domains || domains.length === 0) return repairs;
  
  return repairs.filter(issue =>
    domains.includes(issue.domain) || domains.includes(issue.issue_domain)
  );
}

// Load local patterns synchronously at startup (always available as fallback)
const DEPRECATION_PATTERNS = loadLocalDeprecationPatterns();

/**
 * Check YAML configuration for deprecated patterns.
 * Uses the best available patterns (remote if cached, local as fallback).
 * Also checks HA alerts and repair issues for relevant warnings.
 */
async function checkConfigForDeprecations(yamlConfig, integration = null) {
  const warnings = [];
  const suggestions = [];
  let deprecated = false;
  
  // Get the best available patterns (tries remote/cached, falls back to local)
  const patterns = await getDeprecationPatterns();
  
  for (const pattern of patterns) {
    // Skip patterns not relevant to the specified integration
    if (integration && pattern.integration && pattern.integration !== integration) {
      continue;
    }
    
    if (pattern.pattern.test(yamlConfig)) {
      deprecated = deprecated || pattern.deprecated_in !== undefined;
      
      const severity = pattern.severity || (pattern.deprecated_in ? "warning" : "info");
      const warning = pattern.deprecated_in 
        ? `[DEPRECATED since ${pattern.deprecated_in}] ${pattern.message}`
        : `[INFO] ${pattern.message}`;
      
      warnings.push(warning);
      if (pattern.suggestion) {
        suggestions.push(pattern.suggestion);
      }
    }
  }
  
  // Check HA alerts for the specified integration
  if (integration) {
    try {
      const alerts = await getAlertsForIntegration(integration);
      for (const alert of alerts) {
        warnings.push(`[HA ALERT] ${alert.title || alert.id}: Known issue affecting '${integration}'. See: ${alert.alert_url || ""}`);
      }
    } catch (_) { /* non-critical */ }
  }
  
  return { deprecated, warnings, suggestions };
}

// ============================================================================
// CONFIG VALIDATION HELPERS
// ============================================================================

/**
 * Extract Jinja2 templates from YAML content and validate each through HA's
 * template engine. Templates containing automation context variables (trigger.*,
 * this.*, etc.) are flagged as unverifiable rather than failed.
 */
async function extractAndValidateTemplates(yamlContent) {
  const results = [];
  
  // Match {{ ... }} template expressions (handles multiline)
  const templateRegex = /\{\{[\s\S]*?\}\}/g;
  // Match {% ... %} template blocks
  const blockRegex = /\{%[\s\S]*?%\}/g;
  
  const templates = new Set();
  
  let match;
  while ((match = templateRegex.exec(yamlContent)) !== null) {
    templates.add(match[0]);
  }
  while ((match = blockRegex.exec(yamlContent)) !== null) {
    templates.add(match[0]);
  }
  
  // Context variables that can't be validated statically
  const contextVars = [
    "trigger.", "this.", "context.", "wait.", "repeat.", "response.",
  ];
  
  for (const template of templates) {
    const hasContextVars = contextVars.some(v => template.includes(v));
    
    if (hasContextVars) {
      results.push({
        template: template.substring(0, 100) + (template.length > 100 ? "..." : ""),
        status: "skipped",
        reason: "Contains runtime context variables (trigger/this/wait/repeat) that cannot be validated statically.",
      });
      continue;
    }
    
    try {
      const rendered = await callHA("/template", "POST", { template });
      results.push({
        template: template.substring(0, 100) + (template.length > 100 ? "..." : ""),
        status: "valid",
        result: String(rendered).substring(0, 200),
      });
    } catch (error) {
      results.push({
        template: template.substring(0, 100) + (template.length > 100 ? "..." : ""),
        status: "error",
        error: error.message,
      });
    }
  }
  
  return results;
}

/**
 * Validate YAML structure for common HA configuration patterns.
 * Checks for required keys, correct nesting, and structural issues.
 * This is a lightweight structural check, not a full schema validation.
 */
function validateYamlStructure(yamlContent) {
  const issues = [];
  
  // Check for automation structure
  const automationBlockRegex = /^automation(?:\s+\w+)?:\s*\n([\s\S]*?)(?=^\S|\Z)/gm;
  let autoMatch;
  while ((autoMatch = automationBlockRegex.exec(yamlContent)) !== null) {
    const block = autoMatch[1];
    // Check each automation entry for required fields
    const entries = block.split(/^\s*-\s+/m).filter(e => e.trim());
    for (const entry of entries) {
      const hasTrigger = /(?:^|\n)\s*(?:trigger|triggers)\s*:/m.test(entry);
      const hasAction = /(?:^|\n)\s*(?:action|actions|sequence)\s*:/m.test(entry);
      const hasAlias = /(?:^|\n)\s*alias\s*:/m.test(entry);
      
      if (hasAlias || hasTrigger || hasAction) {
        if (!hasTrigger) {
          issues.push({
            severity: "error",
            message: "Automation is missing 'trigger:' (or 'triggers:'). Every automation must define at least one trigger.",
          });
        }
        if (!hasAction) {
          issues.push({
            severity: "error",
            message: "Automation is missing 'action:' (or 'actions:'). Every automation must define at least one action.",
          });
        }
      }
    }
  }
  
  // Check for script structure
  const scriptBlockRegex = /^script:\s*\n([\s\S]*?)(?=^\S|\Z)/gm;
  let scriptMatch;
  while ((scriptMatch = scriptBlockRegex.exec(yamlContent)) !== null) {
    const block = scriptMatch[1];
    // Scripts need a sequence
    const scriptNames = block.match(/^\s{2}(\w+):/gm);
    if (scriptNames) {
      for (const name of scriptNames) {
        const scriptName = name.trim().replace(":", "");
        // Get the content after this script name until the next script
        const scriptContentRegex = new RegExp(`^\\s{2}${scriptName}:\\s*\\n([\\s\\S]*?)(?=^\\s{2}\\w+:|$)`, "m");
        const contentMatch = scriptContentRegex.exec(block);
        if (contentMatch) {
          const hasSequence = /\s*(?:sequence|action|actions)\s*:/m.test(contentMatch[1]);
          if (!hasSequence) {
            issues.push({
              severity: "warning",
              message: `Script '${scriptName}' may be missing a 'sequence:' (or 'action:') key.`,
            });
          }
        }
      }
    }
  }
  
  // Check for template sensor structure
  const templateBlockRegex = /^template:\s*\n([\s\S]*?)(?=^\S|\Z)/gm;
  let templateMatch;
  while ((templateMatch = templateBlockRegex.exec(yamlContent)) !== null) {
    const block = templateMatch[1];
    // Template sensors need either 'state:' or 'value_template:'
    const sensorBlocks = block.split(/^\s*-\s*(?=sensor|binary_sensor)/m).filter(e => e.trim());
    for (const sBlock of sensorBlocks) {
      if (/^\s*(?:sensor|binary_sensor)\s*:/m.test(sBlock)) {
        const nameMatches = sBlock.match(/name:\s*["']?([^"'\n]+)/g);
        if (nameMatches) {
          const hasState = /\s*(?:state|value_template)\s*:/m.test(sBlock);
          if (!hasState) {
            issues.push({
              severity: "warning",
              message: "Template sensor definition may be missing a 'state:' key.",
            });
          }
        }
      }
    }
  }
  
  return issues;
}

/**
 * Safely resolve and validate a file path within the HA config directory.
 * Returns the resolved absolute path, or null if the path is invalid/unsafe.
 */
function resolveConfigPath(filePath) {
  // Reject absolute paths that point outside config dir
  if (isAbsolute(filePath) && !filePath.startsWith(HA_CONFIG_DIR)) {
    return null;
  }
  
  // Resolve relative paths against the config directory
  const resolved = isAbsolute(filePath) ? filePath : join(HA_CONFIG_DIR, filePath);
  const normalized = normalize(resolved);
  
  // Ensure the resolved path is still within the config directory
  if (!normalized.startsWith(HA_CONFIG_DIR)) {
    return null;
  }
  
  // Block access to internal directories
  const relativePath = normalized.substring(HA_CONFIG_DIR.length + 1);
  const blocked = [".storage", ".cloud", "deps", "tts", "__pycache__"];
  if (blocked.some(dir => relativePath.startsWith(dir + "/") || relativePath === dir)) {
    return null;
  }
  
  return normalized;
}

// ============================================================================
// HELPER: Create annotated content
// ============================================================================

function createTextContent(text, options = {}) {
  const content = { type: "text", text };
  if (options.audience || options.priority !== undefined) {
    content.annotations = {};
    if (options.audience) content.annotations.audience = options.audience;
    if (options.priority !== undefined) content.annotations.priority = options.priority;
  }
  return content;
}

function createResourceLink(uri, name, description, options = {}) {
  const link = {
    type: "resource_link",
    uri,
    name,
    description,
  };
  if (options.mimeType) link.mimeType = options.mimeType;
  if (options.audience || options.priority !== undefined) {
    link.annotations = {};
    if (options.audience) link.annotations.audience = options.audience;
    if (options.priority !== undefined) link.annotations.priority = options.priority;
  }
  return link;
}

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  {
    name: "home-assistant",
    version: "2.2.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: false,
      },
      resources: {
        subscribe: false,
        listChanged: false,
      },
      prompts: {
        listChanged: false,
      },
      logging: {},
    },
  }
);

// ============================================================================
// TOOLS DEFINITION - With titles, outputSchema, and annotations
// ============================================================================

const TOOLS = [
  // === STATE MANAGEMENT ===
  {
    name: "get_states",
    title: "Get Entity States",
    description: "Get the current state of entities. Can return all entities, filter by domain, or get a specific entity. Returns entity_id, state, and key attributes.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "Specific entity ID (e.g., 'light.living_room'). If not provided, returns all/filtered entities.",
        },
        domain: {
          type: "string",
          description: "Filter by domain (e.g., 'light', 'switch', 'sensor', 'automation')",
        },
        summarize: {
          type: "boolean",
          description: "If true, returns a human-readable summary instead of raw data",
        },
      },
    },
    outputSchema: SCHEMAS.entityStateArray,
    annotations: {
      readOnly: true,
      idempotent: true,
      openWorld: false,
    },
  },
  {
    name: "search_entities",
    title: "Search Entities",
    description: "Search for entities by name, type, or description. Uses semantic matching to find relevant entities.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., 'bedroom lights', 'temperature sensors', 'front door')",
        },
      },
      required: ["query"],
    },
    outputSchema: SCHEMAS.searchResult,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_entity_details",
    title: "Get Entity Details",
    description: "Get detailed information about an entity including its relationships to devices, areas, and related entities.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity ID to get details for",
        },
      },
      required: ["entity_id"],
    },
    outputSchema: SCHEMAS.entityDetails,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === SERVICE CALLS ===
  {
    name: "call_service",
    title: "Call Home Assistant Service",
    description: "Call a Home Assistant service to control devices or trigger actions. Use for turning on/off lights, running scripts, triggering automations, etc. THIS MODIFIES DEVICE STATE.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Service domain (e.g., 'light', 'switch', 'automation', 'script', 'climate')",
        },
        service: {
          type: "string",
          description: "Service name (e.g., 'turn_on', 'turn_off', 'toggle', 'trigger', 'set_temperature')",
        },
        target: {
          type: "object",
          description: "Target for the service call",
          properties: {
            entity_id: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } }
              ],
              description: "Entity ID(s) to target"
            },
            area_id: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } }
              ],
              description: "Area ID(s) to target"
            },
            device_id: {
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } }
              ],
              description: "Device ID(s) to target"
            },
          },
        },
        data: {
          type: "object",
          description: "Additional service data (e.g., brightness: 255, color_temp: 400, temperature: 72)",
        },
      },
      required: ["domain", "service"],
    },
    outputSchema: SCHEMAS.serviceCallResult,
    annotations: {
      destructive: true,
      idempotent: false,
      requiresConfirmation: true,
    },
  },
  {
    name: "get_services",
    title: "List Available Services",
    description: "List available services, optionally filtered by domain. Shows what actions can be performed.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Filter services by domain (e.g., 'light', 'climate')",
        },
      },
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === HISTORY & LOGBOOK ===
  {
    name: "get_history",
    title: "Get Entity History",
    description: "Get historical state data for entities. Essential for analyzing trends, debugging issues, or understanding patterns.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "Entity ID to get history for (required)",
        },
        start_time: {
          type: "string",
          description: "Start time in ISO format (e.g., '2024-01-15T00:00:00'). Defaults to 24 hours ago.",
        },
        end_time: {
          type: "string",
          description: "End time in ISO format. Defaults to now.",
        },
        minimal: {
          type: "boolean",
          description: "If true, returns minimal response (faster, less data)",
        },
      },
      required: ["entity_id"],
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_logbook",
    title: "Get Activity Logbook",
    description: "Get logbook entries showing what happened in Home Assistant. Useful for understanding recent activity and debugging.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Filter by specific entity" },
        start_time: { type: "string", description: "Start time in ISO format. Defaults to 24 hours ago." },
        end_time: { type: "string", description: "End time in ISO format. Defaults to now." },
      },
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === CONFIGURATION ===
  {
    name: "get_config",
    title: "Get Home Assistant Configuration",
    description: "Get Home Assistant configuration including location, units, version, and loaded components.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_areas",
    title: "List All Areas",
    description: "List all areas defined in Home Assistant with their IDs and names.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: SCHEMAS.areaArray,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_devices",
    title: "List Devices",
    description: "List devices registered in Home Assistant, optionally filtered by area.",
    inputSchema: {
      type: "object",
      properties: {
        area_id: { type: "string", description: "Filter devices by area ID" },
      },
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "validate_config",
    title: "Validate Configuration",
    description: "Validate Home Assistant configuration files. Run this before restarting to catch errors.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: SCHEMAS.configValidation,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_error_log",
    title: "Get Error Log",
    description: "Get the Home Assistant error log. Useful for debugging issues.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", description: "Number of lines to return (default: 100)" },
      },
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === EVENTS & TEMPLATES ===
  {
    name: "fire_event",
    title: "Fire Custom Event",
    description: "Fire a custom event in Home Assistant. Can be used to trigger automations or communicate between systems.",
    inputSchema: {
      type: "object",
      properties: {
        event_type: { type: "string", description: "Event type to fire (e.g., 'custom_event', 'my_notification')" },
        event_data: { type: "object", description: "Optional data to include with the event" },
      },
      required: ["event_type"],
    },
    annotations: {
      destructive: true,
      idempotent: false,
    },
  },
  {
    name: "render_template",
    title: "Render Jinja2 Template",
    description: "Render a Jinja2 template using Home Assistant's template engine. Powerful for complex data extraction and formatting.",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", description: "Jinja2 template (e.g., '{{ states(\"sensor.temperature\") }}', '{{ now() }}')" },
      },
      required: ["template"],
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === CALENDARS ===
  {
    name: "get_calendars",
    title: "List Calendars",
    description: "List all calendar entities in Home Assistant.",
    inputSchema: { type: "object", properties: {} },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_calendar_events",
    title: "Get Calendar Events",
    description: "Get events from a specific calendar within a time range.",
    inputSchema: {
      type: "object",
      properties: {
        calendar_entity: { type: "string", description: "Calendar entity ID (e.g., 'calendar.family')" },
        start: { type: "string", description: "Start time in ISO format" },
        end: { type: "string", description: "End time in ISO format" },
      },
      required: ["calendar_entity"],
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === INTELLIGENCE ===
  {
    name: "detect_anomalies",
    title: "Detect Anomalies",
    description: "Scan all entities for potential anomalies like low batteries, unusual sensor readings, or devices in unexpected states.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Limit scan to specific domain" },
      },
    },
    outputSchema: SCHEMAS.anomalyArray,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_suggestions",
    title: "Get Automation Suggestions",
    description: "Get intelligent automation and optimization suggestions based on your current Home Assistant setup.",
    inputSchema: { type: "object", properties: {} },
    outputSchema: SCHEMAS.suggestionArray,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "diagnose_entity",
    title: "Diagnose Entity",
    description: "Run diagnostics on an entity to help troubleshoot issues. Checks state history, related entities, and common problems.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "Entity to diagnose" },
      },
      required: ["entity_id"],
    },
    outputSchema: SCHEMAS.diagnostics,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === DOCUMENTATION ===
  {
    name: "get_integration_docs",
    title: "Get Integration Documentation",
    description: "Fetch current documentation for a Home Assistant integration. Use this BEFORE writing configuration to ensure you use the latest syntax. Returns configuration examples, setup instructions, and deprecation notices.",
    inputSchema: {
      type: "object",
      properties: {
        integration: {
          type: "string",
          description: "Integration name (e.g., 'template', 'mqtt', 'rest', 'sensor', 'automation')",
        },
        section: {
          type: "string",
          enum: ["all", "configuration", "examples"],
          description: "Which section to focus on (default: 'configuration')",
        },
      },
      required: ["integration"],
    },
    outputSchema: SCHEMAS.integrationDocs,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_breaking_changes",
    title: "Get Breaking Changes",
    description: "Fetch recent breaking changes from Home Assistant release notes. Use this when troubleshooting configurations that stopped working after an update, or to check compatibility before suggesting configurations.",
    inputSchema: {
      type: "object",
      properties: {
        integration: {
          type: "string",
          description: "Filter by specific integration name (optional)",
        },
        version: {
          type: "string",
          description: "Get changes for a specific HA version (e.g., '2024.12'). Defaults to recent versions.",
        },
      },
    },
    outputSchema: SCHEMAS.breakingChanges,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "check_config_syntax",
    title: "Check Configuration Syntax",
    description: "Analyze YAML configuration for deprecated syntax patterns and suggest modern alternatives. Use this to validate configuration before presenting it to the user.",
    inputSchema: {
      type: "object",
      properties: {
        yaml_config: {
          type: "string",
          description: "The YAML configuration to check",
        },
        integration: {
          type: "string",
          description: "The integration this config is for (helps with specific checks)",
        },
      },
      required: ["yaml_config"],
    },
    outputSchema: SCHEMAS.configSyntaxCheck,
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "write_config_safe",
    title: "Safe Config Writer",
    description: "Write YAML configuration to a file with automatic validation. Checks for deprecations, validates Jinja2 templates through HA's engine, verifies structural correctness, and runs HA's full config check. If validation fails, the original file is restored and errors are returned for correction. Use dry_run=true to validate without writing. This is the recommended way to write configuration files.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path relative to /homeassistant/ (e.g., 'configuration.yaml', 'automations.yaml', 'packages/lights.yaml')",
        },
        content: {
          type: "string",
          description: "The YAML content to write",
        },
        dry_run: {
          type: "boolean",
          description: "If true, validate without writing to disk (default: false). Use this to pre-check config before committing.",
        },
        validate_templates: {
          type: "boolean",
          description: "If true (default), extract and validate Jinja2 templates through HA's template engine.",
        },
        confirm_deletions: {
          type: "boolean",
          description: "If true, confirms that you intentionally want to remove entries from this file (e.g. deleting an automation, script, or scene). Default: false. Without this flag, writes to automations.yaml, scripts.yaml, or scenes.yaml that would reduce the number of entries are blocked to prevent accidental data loss.",
        },
      },
      required: ["file_path", "content"],
    },
    annotations: {
      readOnly: false,
      idempotent: false,
      destructive: false,
    },
  },
  
  // === UPDATE MANAGEMENT ===
  {
    name: "get_available_updates",
    title: "Get Available Updates",
    description: "Check for available updates across Home Assistant Core, OS, Supervisor, and all installed apps. Returns version info and update status for each component.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          enum: ["all", "core", "os", "supervisor", "addons"],
          description: "Which component to check (default: 'all')",
        },
      },
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_addon_changelog",
    title: "Get App Changelog",
    description: "Get the changelog for an installed app to see what changes are included in updates.",
    inputSchema: {
      type: "object",
      properties: {
        addon_slug: {
          type: "string",
          description: "The slug identifier of the app (e.g., 'core_configurator', 'a0d7b954_vscode')",
        },
      },
      required: ["addon_slug"],
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "update_component",
    title: "Update Component",
    description: "Initiate an update for a Home Assistant component (Core, OS, Supervisor) or an app. Returns a job_id for progress monitoring. NOTE: Cannot update OpenCode itself from within - use Home Assistant UI for self-updates.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          enum: ["core", "os", "supervisor", "addon"],
          description: "Type of component to update",
        },
        addon_slug: {
          type: "string",
          description: "Required if component is 'addon' - the app's slug identifier",
        },
        backup: {
          type: "boolean",
          description: "Create a backup before updating (default: true for core/addons)",
        },
      },
      required: ["component"],
    },
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
    },
  },
  {
    name: "get_update_progress",
    title: "Get Update Progress",
    description: "Monitor the progress of a running update job. Poll this endpoint to get real-time progress updates including percentage, current stage, and completion status.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job UUID returned when initiating an update",
        },
      },
      required: ["job_id"],
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "get_running_jobs",
    title: "Get Running Jobs",
    description: "List all currently running or recently completed Supervisor jobs. Useful for monitoring ongoing operations like updates, backups, or restores.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  
  // === ESPHOME INTEGRATION ===
  {
    name: "esphome_list_devices",
    title: "List ESPHome Devices",
    description: "List all configured ESPHome devices with current and deployed firmware versions. Requires ESPHome add-on to be installed and running.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: {
      readOnly: true,
      idempotent: true,
    },
  },
  {
    name: "esphome_compile",
    title: "Compile ESPHome Firmware",
    description: "Compile firmware for an ESPHome device. Returns the full build log including any errors. This may take 1-5 minutes depending on device complexity.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description: "Device name or configuration file name (e.g., 'living-room-sensor' or 'living-room-sensor.yaml')",
        },
      },
      required: ["device"],
    },
    annotations: {
      readOnly: false,
      idempotent: true,
    },
  },
  {
    name: "esphome_upload",
    title: "Upload ESPHome Firmware",
    description: "Upload compiled firmware to an ESPHome device via OTA (Over-The-Air) or USB. For OTA, the device must be online and reachable.",
    inputSchema: {
      type: "object",
      properties: {
        device: {
          type: "string",
          description: "Device name or configuration file name",
        },
        port: {
          type: "string",
          description: "Upload target - device IP/hostname for OTA (e.g., '192.168.1.100') or USB path (e.g., '/dev/ttyUSB0')",
        },
      },
      required: ["device", "port"],
    },
    annotations: {
      readOnly: false,
      idempotent: false,
    },
  },
  
  // === FIRMWARE UPDATE MONITORING ===
  {
    name: "watch_firmware_update",
    title: "Watch Firmware Update Progress",
    description: "Check firmware update status or start an update. Returns current state immediately (does not block). Call repeatedly to monitor progress. For ESPHome, WLED, Zigbee coordinators, and other device updates.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The update entity to check (e.g., 'update.garage_sensor_firmware', 'update.wled_living_room_update')",
        },
        start_update: {
          type: "boolean",
          description: "If true, start the update. If false (default), just check current status.",
        },
      },
      required: ["entity_id"],
    },
    annotations: {
      readOnly: false,
      idempotent: false,
    },
  },
  {
    name: "hab_run",
    title: "Run hab CLI Command",
    description: "Run a Home Assistant Builder (hab) CLI command. hab is a comprehensive admin CLI that covers the full Home Assistant admin area via REST and WebSocket APIs. Use this for: dashboard CRUD (create views, sections, cards), area/floor/zone/label management, helper entity creation, automation CRUD via API, script management, backup/restore, blueprint management, calendar operations, device management, entity groups, and search. hab outputs structured JSON. Examples: 'entity list --domain light', 'area create Kitchen', 'dashboard list', 'automation list', 'helper create input_boolean --name Guest Mode', 'backup list', 'system health'. Run with just 'help' to see all available command groups.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The hab command and arguments to run (without the 'hab' prefix). Examples: 'entity list', 'area create Kitchen', 'dashboard list', 'automation get my-automation', 'helper create input_boolean --name \"Guest Mode\"', 'backup create', 'system info'",
        },
      },
      required: ["command"],
    },
    annotations: {
      readOnly: false,
      idempotent: false,
    },
  },
];

// ============================================================================
// RESOURCES DEFINITION - With titles
// ============================================================================

const RESOURCES = [
  {
    uri: "ha://states/summary",
    name: "state_summary",
    title: "State Summary",
    description: "Human-readable summary of all Home Assistant entity states",
    mimeType: "text/markdown",
  },
  {
    uri: "ha://automations",
    name: "automations",
    title: "Automations List",
    description: "List of all automations with their current state and last triggered time",
    mimeType: "application/json",
  },
  {
    uri: "ha://scripts",
    name: "scripts",
    title: "Scripts List",
    description: "List of all scripts available in Home Assistant",
    mimeType: "application/json",
  },
  {
    uri: "ha://scenes",
    name: "scenes",
    title: "Scenes List",
    description: "List of all scenes that can be activated",
    mimeType: "application/json",
  },
  {
    uri: "ha://areas",
    name: "areas",
    title: "Areas List",
    description: "All areas defined in Home Assistant with associated entities",
    mimeType: "application/json",
  },
  {
    uri: "ha://config",
    name: "config",
    title: "HA Configuration",
    description: "Home Assistant configuration details",
    mimeType: "application/json",
  },
  {
    uri: "ha://integrations",
    name: "integrations",
    title: "Loaded Integrations",
    description: "List of loaded integrations/components",
    mimeType: "application/json",
  },
  {
    uri: "ha://anomalies",
    name: "anomalies",
    title: "Detected Anomalies",
    description: "Currently detected anomalies and potential issues",
    mimeType: "application/json",
  },
  {
    uri: "ha://suggestions",
    name: "suggestions",
    title: "Automation Suggestions",
    description: "Automation and optimization suggestions",
    mimeType: "application/json",
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "ha://states/{domain}",
    name: "states_by_domain",
    title: "States by Domain",
    description: "Get all entity states for a specific domain (e.g., light, switch, sensor)",
    mimeType: "application/json",
  },
  {
    uriTemplate: "ha://entity/{entity_id}",
    name: "entity_details",
    title: "Entity Details",
    description: "Detailed information about a specific entity",
    mimeType: "application/json",
  },
  {
    uriTemplate: "ha://area/{area_id}",
    name: "area_details",
    title: "Area Details",
    description: "All entities and devices in a specific area",
    mimeType: "application/json",
  },
  {
    uriTemplate: "ha://history/{entity_id}",
    name: "entity_history",
    title: "Entity History",
    description: "Recent state history for an entity (last 24 hours)",
    mimeType: "application/json",
  },
];

// ============================================================================
// PROMPTS DEFINITION - With titles
// ============================================================================

const PROMPTS = [
  {
    name: "troubleshoot_entity",
    title: "Troubleshoot Entity",
    description: "Guided troubleshooting for a problematic entity. Analyzes state, history, and related entities to identify issues.",
    arguments: [
      { name: "entity_id", description: "The entity ID that's having problems", required: true },
      { name: "problem_description", description: "Brief description of the problem", required: false },
    ],
  },
  {
    name: "create_automation",
    title: "Create Automation",
    description: "Step-by-step guide to create a new automation. Helps identify triggers, conditions, and actions.",
    arguments: [
      { name: "goal", description: "What you want the automation to accomplish", required: true },
    ],
  },
  {
    name: "energy_audit",
    title: "Energy Audit",
    description: "Analyze energy usage and suggest optimizations. Reviews power sensors, lights, climate, and usage patterns.",
    arguments: [],
  },
  {
    name: "scene_builder",
    title: "Scene Builder",
    description: "Interactive scene creation assistant. Captures current states or helps design new scenes.",
    arguments: [
      { name: "area", description: "Area to create scene for (optional)", required: false },
      { name: "mood", description: "Desired mood/atmosphere (e.g., 'relaxing', 'movie night', 'energizing')", required: false },
    ],
  },
  {
    name: "security_review",
    title: "Security Review",
    description: "Review security-related entities and suggest improvements. Checks locks, sensors, cameras, and alarm systems.",
    arguments: [],
  },
  {
    name: "morning_routine",
    title: "Morning Routine Designer",
    description: "Design a morning routine automation based on your devices and preferences.",
    arguments: [
      { name: "wake_time", description: "Usual wake-up time (e.g., '7:00 AM')", required: false },
    ],
  },
];

// ============================================================================
// REQUEST HANDLERS
// ============================================================================

// --- Logging: Set Level ---
server.setRequestHandler(SetLevelRequestSchema, async (request) => {
  const { level } = request.params;
  if (LOG_LEVELS.includes(level)) {
    currentLogLevel = level;
    sendLog("info", "mcp-server", { action: "log_level_changed", level });
    return {};
  }
  throw new Error(`Invalid log level: ${level}`);
});

// --- List Tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  sendLog("debug", "mcp-server", { action: "list_tools" });
  // Strip newer MCP spec fields that some clients may not support
  // Keep only: name, description, inputSchema (standard fields)
  const compatibleTools = TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
  return { tools: compatibleTools };
});

// --- Call Tool ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  sendLog("info", "mcp-server", { action: "call_tool", tool: name, args });

  // Helper to strip unsupported MCP features from response for OpenCode compatibility
  const makeCompatibleResponse = (result) => {
    // Keep only standard fields: content, isError
    // Remove: structuredContent, resourceLinks (not supported by OpenCode)
    return {
      content: result.content,
      ...(result.isError && { isError: result.isError }),
    };
  };

  try {
    let result;
    switch (name) {
      // === STATE MANAGEMENT ===
      case "get_states": {
        if (args?.entity_id) {
          const state = await callHA(`/states/${args.entity_id}`);
          return makeCompatibleResponse({
            content: [
              createTextContent(JSON.stringify(state, null, 2), { audience: ["assistant"], priority: 0.8 }),
            ],
          });
        }
        
        let states = await callHA("/states");
        if (args?.domain) {
          states = states.filter((s) => s.entity_id.startsWith(`${args.domain}.`));
        }
        
        if (args?.summarize) {
          const summary = generateStateSummary(states);
          return makeCompatibleResponse({
            content: [createTextContent(summary, { audience: ["user", "assistant"], priority: 0.9 })],
          });
        }
        
        const simplified = states.map((s) => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: s.attributes?.friendly_name,
          device_class: s.attributes?.device_class,
        }));
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(simplified, null, 2), { audience: ["assistant"], priority: 0.7 })],
        });
      }

      case "search_entities": {
        const states = await callHA("/states");
        const results = searchEntities(states, args.query);
        
        return makeCompatibleResponse({
          content: [
            createTextContent(
              results.length > 0 
                ? JSON.stringify(results, null, 2)
                : `No entities found matching "${args.query}"`,
              { audience: ["assistant"], priority: 0.8 }
            ),
          ],
        });
      }

      case "get_entity_details": {
        const relationships = await getEntityRelationships(args.entity_id);
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(relationships, null, 2), { audience: ["assistant"], priority: 0.8 })],
        });
      }

      // === SERVICE CALLS ===
      case "call_service": {
        const { domain, service, target, data } = args;
        sendLog("notice", "ha-service", { action: "call", domain, service, target });
        
        const payload = { ...data };
        if (target) {
          Object.assign(payload, target);
        }
        const result = await callHA(`/services/${domain}/${service}`, "POST", payload);
        
        return makeCompatibleResponse({
          content: [
            createTextContent(
              `Service ${domain}.${service} called successfully.\n${JSON.stringify(result, null, 2)}`,
              { audience: ["user", "assistant"], priority: 0.9 }
            ),
          ],
        });
      }

      case "get_services": {
        let services = await callHA("/services");
        if (args?.domain) {
          services = services.filter((s) => s.domain === args.domain);
        }
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(services, null, 2), { audience: ["assistant"], priority: 0.6 })],
        });
      }

      // === HISTORY & LOGBOOK ===
      case "get_history": {
        const entityId = args.entity_id;
        const startTime = args.start_time || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams({ filter_entity_id: entityId });
        if (args.end_time) params.append("end_time", args.end_time);
        if (args.minimal) {
          params.append("minimal_response", "true");
          params.append("no_attributes", "true");
        }
        
        const history = await callHA(`/history/period/${encodeURIComponent(startTime)}?${params}`);
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(history, null, 2), { audience: ["assistant"], priority: 0.7 })],
        });
      }

      case "get_logbook": {
        const startTime = args.start_time || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const params = new URLSearchParams();
        if (args.entity_id) params.append("entity", args.entity_id);
        if (args.end_time) params.append("end_time", args.end_time);
        
        const logbook = await callHA(`/logbook/${encodeURIComponent(startTime)}?${params}`);
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(logbook, null, 2), { audience: ["assistant"], priority: 0.7 })],
        });
      }

      // === CONFIGURATION ===
      case "get_config": {
        const config = await callHA("/config");
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(config, null, 2), { audience: ["assistant"], priority: 0.6 })],
        });
      }

      case "get_areas": {
        // Use namespace to properly accumulate values in Jinja2 loop
        const result = await callHA("/template", "POST", {
          template: "{% set ns = namespace(areas=[]) %}{% for area in areas() %}{% set ns.areas = ns.areas + [{'id': area, 'name': area_name(area)}] %}{% endfor %}{{ ns.areas | tojson }}"
        });
        return makeCompatibleResponse({
          content: [createTextContent(result, { audience: ["assistant"], priority: 0.7 })],
        });
      }

      case "get_devices": {
        // Get devices by extracting unique device_ids from all entity states
        // Then use device_attr() to get device details
        let template;
        if (args?.area_id) {
          // Get devices for a specific area
          template = `{% set ns = namespace(devices=[]) %}{% for device_id in area_devices('${args.area_id}') %}{% set ns.devices = ns.devices + [{'id': device_id, 'name': device_attr(device_id, 'name'), 'manufacturer': device_attr(device_id, 'manufacturer'), 'model': device_attr(device_id, 'model')}] %}{% endfor %}{{ ns.devices | tojson }}`;
        } else {
          // Get all devices by iterating through states and collecting unique device_ids
          template = `{% set ns = namespace(device_ids=[]) %}{% for state in states %}{% if device_id(state.entity_id) and device_id(state.entity_id) not in ns.device_ids %}{% set ns.device_ids = ns.device_ids + [device_id(state.entity_id)] %}{% endif %}{% endfor %}{% set ns2 = namespace(devices=[]) %}{% for did in ns.device_ids %}{% set ns2.devices = ns2.devices + [{'id': did, 'name': device_attr(did, 'name'), 'manufacturer': device_attr(did, 'manufacturer'), 'model': device_attr(did, 'model'), 'area': device_attr(did, 'area_id')}] %}{% endfor %}{{ ns2.devices | tojson }}`;
        }
        const result = await callHA("/template", "POST", { template });
        return makeCompatibleResponse({
          content: [createTextContent(result, { audience: ["assistant"], priority: 0.6 })],
        });
      }

      case "validate_config": {
        const result = await callHA("/config/core/check_config", "POST");
        return makeCompatibleResponse({
          content: [
            createTextContent(
              JSON.stringify(result, null, 2),
              { audience: ["user", "assistant"], priority: 0.9 }
            ),
          ],
        });
      }

      case "get_error_log": {
        // Use HA Core API via Supervisor proxy - correct endpoint path
        const log = await callHA("/core/api/error_log");
        const lines = args?.lines || 100;
        const logLines = log.split("\n").slice(-lines).join("\n");
        return makeCompatibleResponse({
          content: [createTextContent(logLines, { audience: ["assistant"], priority: 0.8 })],
        });
      }

      // === EVENTS & TEMPLATES ===
      case "fire_event": {
        const { event_type, event_data } = args;
        sendLog("notice", "ha-event", { action: "fire", event_type });
        await callHA(`/events/${event_type}`, "POST", event_data || {});
        return makeCompatibleResponse({
          content: [createTextContent(`Event '${event_type}' fired successfully.`, { audience: ["user"], priority: 0.9 })],
        });
      }

      case "render_template": {
        const result = await callHA("/template", "POST", { template: args.template });
        return makeCompatibleResponse({
          content: [createTextContent(result, { audience: ["assistant"], priority: 0.8 })],
        });
      }

      // === CALENDARS ===
      case "get_calendars": {
        const calendars = await callHA("/calendars");
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(calendars, null, 2), { audience: ["assistant"], priority: 0.6 })],
        });
      }

      case "get_calendar_events": {
        const { calendar_entity } = args;
        const start = args.start || new Date().toISOString();
        const end = args.end || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        const events = await callHA(
          `/calendars/${calendar_entity}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
        );
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(events, null, 2), { audience: ["assistant"], priority: 0.7 })],
        });
      }

      // === INTELLIGENCE ===
      case "detect_anomalies": {
        let states = await callHA("/states");
        if (args?.domain) {
          states = states.filter((s) => s.entity_id.startsWith(`${args.domain}.`));
        }
        
        const anomalies = states
          .map(detectAnomaly)
          .filter(Boolean)
          .sort((a, b) => (b.severity === "warning" ? 1 : 0) - (a.severity === "warning" ? 1 : 0));
        
        if (anomalies.length === 0) {
          return makeCompatibleResponse({
            content: [createTextContent("No anomalies detected. All entities appear to be operating normally.", { audience: ["user"], priority: 0.9 })],
          });
        }
        
        return makeCompatibleResponse({
          content: [
            createTextContent(
              `Found ${anomalies.length} potential anomalies:\n\n${JSON.stringify(anomalies, null, 2)}`,
              { audience: ["user", "assistant"], priority: 0.9 }
            ),
          ],
        });
      }

      case "get_suggestions": {
        const states = await callHA("/states");
        const suggestions = generateSuggestions(states);
        
        if (suggestions.length === 0) {
          return makeCompatibleResponse({
            content: [createTextContent("No suggestions at this time. Your Home Assistant setup looks well configured!", { audience: ["user"], priority: 0.8 })],
          });
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(suggestions, null, 2), { audience: ["user", "assistant"], priority: 0.8 })],
        });
      }

      case "diagnose_entity": {
        const { entity_id } = args;
        sendLog("info", "diagnostics", { action: "diagnose", entity_id });
        
        const diagnostics = {
          entity_id,
          timestamp: new Date().toISOString(),
          checks: [],
        };
        
        try {
          const state = await callHA(`/states/${entity_id}`);
          diagnostics.current_state = state;
          diagnostics.checks.push({ check: "Current State", status: "ok", details: state.state });
          
          if (state.state === "unavailable" || state.state === "unknown") {
            diagnostics.checks.push({ 
              check: "Availability", 
              status: "warning", 
              details: `Entity is ${state.state}. Check device connectivity.` 
            });
          }
          
          const relationships = await getEntityRelationships(entity_id);
          diagnostics.relationships = relationships;
          diagnostics.checks.push({ 
            check: "Relationships", 
            status: "ok", 
            details: `Found ${relationships.related_entities?.length || 0} related entities` 
          });
          
          const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const params = new URLSearchParams({
            filter_entity_id: entity_id,
            minimal_response: "true",
          });
          const history = await callHA(`/history/period/${encodeURIComponent(startTime)}?${params}`);
          
          if (history && history[0]) {
            const stateChanges = history[0].length;
            diagnostics.history_summary = {
              state_changes_24h: stateChanges,
              last_changed: state.last_changed,
              last_updated: state.last_updated,
            };
            
            diagnostics.checks.push({ 
              check: "Activity", 
              status: stateChanges === 0 ? "info" : "ok", 
              details: stateChanges === 0 ? "No state changes in last 24 hours" : `${stateChanges} state changes in last 24 hours`
            });
          }
          
          const anomaly = detectAnomaly(state);
          if (anomaly) {
            diagnostics.checks.push({ 
              check: "Anomaly Detection", 
              status: anomaly.severity, 
              details: anomaly.reason 
            });
          }
          
        } catch (error) {
          diagnostics.checks.push({ 
            check: "Entity Lookup", 
            status: "error", 
            details: error.message 
          });
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(JSON.stringify(diagnostics, null, 2), { audience: ["assistant"], priority: 0.9 })],
        });
      }

      // === DOCUMENTATION ===
      case "get_integration_docs": {
        const { integration, section = "configuration" } = args;
        sendLog("info", "docs", { action: "get_integration_docs", integration, section });
        
        const url = `${HA_INTEGRATIONS_URL}/${integration}/`;
        let haVersion = "unknown";
        
        // Get current HA version
        try {
          const config = await callHA("/config");
          haVersion = config.version || "unknown";
        } catch (e) {
          sendLog("warning", "docs", { action: "version_fetch_failed", error: e.message });
        }
        
        try {
          const html = await fetchUrl(url);
          const { title, description, content } = extractContentFromHtml(html);
          
          let resultContent = content;
          const examples = extractYamlExamples(content);
          
          // Filter to configuration section if requested
          if (section === "configuration") {
            const configSection = extractConfigurationSection(content);
            if (configSection) {
              resultContent = configSection;
            }
          } else if (section === "examples" && examples.length > 0) {
            resultContent = "## YAML Examples\n\n" + examples.map((ex, i) => `### Example ${i + 1}\n\`\`\`yaml\n${ex}\n\`\`\``).join("\n\n");
          }
          
          const result = {
            integration,
            url,
            title: title || integration,
            description: description || "",
            ha_version: haVersion,
            fetched_at: new Date().toISOString(),
            content: resultContent.substring(0, 15000), // Limit content size
            yaml_examples: examples.slice(0, 5), // Include up to 5 examples
          };
          
          return makeCompatibleResponse({
            content: [
              createTextContent(
                `# ${result.title}\n\n` +
                `**Integration:** ${integration}\n` +
                `**Docs URL:** ${url}\n` +
                `**Your HA Version:** ${haVersion}\n` +
                `**Fetched:** ${result.fetched_at}\n\n` +
                `---\n\n${resultContent.substring(0, 15000)}`,
                { audience: ["assistant"], priority: 0.9 }
              ),
            ],
          });
        } catch (error) {
          // Provide helpful fallback if docs can't be fetched
          return makeCompatibleResponse({
            content: [
              createTextContent(
                `Unable to fetch documentation for '${integration}'.\n\n` +
                `**Docs URL:** ${url}\n` +
                `**Error:** ${error.message}\n\n` +
                `**Suggestion:** You can:\n` +
                `1. Try visiting the URL directly: ${url}\n` +
                `2. Check if the integration name is correct\n` +
                `3. Use \`validate_config\` to check your configuration\n\n` +
                `**Your HA Version:** ${haVersion}`,
                { audience: ["assistant"], priority: 0.8 }
              ),
            ],
          });
        }
      }

      case "get_breaking_changes": {
        const { integration, version } = args;
        sendLog("info", "docs", { action: "get_breaking_changes", integration, version });
        
        let haVersion = "unknown";
        try {
          const config = await callHA("/config");
          haVersion = config.version || "unknown";
        } catch (e) {
          sendLog("warning", "docs", { action: "version_fetch_failed", error: e.message });
        }
        
        // Build a list of known breaking changes (curated, since parsing release notes is complex)
        // This provides immediate value without complex web scraping
        const knownBreakingChanges = [
          {
            version: "2024.12",
            title: "Template sensor/binary_sensor syntax change",
            description: "Legacy 'platform: template' under sensor/binary_sensor is deprecated. Use top-level 'template:' key.",
            integration: "template",
            url: "https://www.home-assistant.io/integrations/template/",
          },
          {
            version: "2024.11",
            title: "MQTT discovery changes",
            description: "MQTT discovery payload format updated for better device support.",
            integration: "mqtt",
            url: "https://www.home-assistant.io/integrations/mqtt/",
          },
          {
            version: "2024.10",
            title: "REST sensor authentication",
            description: "REST sensors now support digest authentication; some configurations may need updating.",
            integration: "rest",
            url: "https://www.home-assistant.io/integrations/rest/",
          },
          {
            version: "2024.8",
            title: "Automation trigger variables",
            description: "Trigger variables are now more strictly typed in automations.",
            integration: "automation",
            url: "https://www.home-assistant.io/docs/automation/trigger/",
          },
          {
            version: "2024.6",
            title: "Time & Date sensor deprecation",
            description: "The time_date platform is deprecated. Use template sensors with now() instead.",
            integration: "time_date",
            url: "https://www.home-assistant.io/integrations/time_date/",
          },
          {
            version: "2024.4",
            title: "Template switch/cover/fan syntax",
            description: "Template platforms for switch, cover, and fan can now use the top-level 'template:' key.",
            integration: "template",
            url: "https://www.home-assistant.io/integrations/template/",
          },
          {
            version: "2024.1",
            title: "Legacy template sensor syntax deprecated",
            description: "The 'platform: template' syntax under sensor: is deprecated in favor of the template: integration.",
            integration: "template",
            url: "https://www.home-assistant.io/integrations/template/",
          },
          {
            version: "2023.12",
            title: "Entity naming convention changes",
            description: "Entities now follow stricter naming conventions. Some entity IDs may have changed.",
            integration: null,
            url: "https://www.home-assistant.io/blog/2023/12/",
          },
          {
            version: "2023.8",
            title: "entity_namespace deprecated",
            description: "The entity_namespace option is deprecated. Use unique_id instead.",
            integration: null,
            url: "https://www.home-assistant.io/blog/2023/08/",
          },
          {
            version: "2023.3",
            title: "white_value deprecated in light services",
            description: "Use 'white' instead of 'white_value' in light service calls.",
            integration: "light",
            url: "https://www.home-assistant.io/integrations/light/",
          },
        ];
        
        // Filter by integration if specified
        let filteredChanges = knownBreakingChanges;
        if (integration) {
          filteredChanges = knownBreakingChanges.filter(
            c => c.integration === integration || c.integration === null
          );
        }
        
        // Filter by version if specified
        if (version) {
          filteredChanges = filteredChanges.filter(c => c.version === version);
        }
        
        // Try to fetch the release notes page for additional context
        let releaseNotesContent = "";
        const targetVersion = version || haVersion.split(".").slice(0, 2).join(".");
        
        try {
          const releaseUrl = `${HA_BLOG_URL}/${targetVersion.replace(".", "/")}/`;
          const html = await fetchUrl(releaseUrl);
          const { content } = extractContentFromHtml(html);
          
          // Extract breaking changes section if present
          const breakingMatch = content.match(/breaking changes?[\s\S]*?(?=\n## |$)/i);
          if (breakingMatch) {
            releaseNotesContent = breakingMatch[0].substring(0, 5000);
          }
        } catch (e) {
          sendLog("debug", "docs", { action: "release_notes_fetch_failed", error: e.message });
        }
        
        const result = {
          ha_version: haVersion,
          queried_version: version || "recent",
          queried_integration: integration || "all",
          changes: filteredChanges,
          release_notes_excerpt: releaseNotesContent || null,
        };
        
        let responseText = `# Breaking Changes\n\n` +
          `**Your HA Version:** ${haVersion}\n` +
          `**Queried:** ${integration ? `integration '${integration}'` : "all integrations"}` +
          `${version ? ` for version ${version}` : ""}\n\n`;
        
        if (filteredChanges.length > 0) {
          responseText += `## Known Breaking Changes\n\n`;
          for (const change of filteredChanges) {
            responseText += `### ${change.version}: ${change.title}\n`;
            responseText += `${change.description}\n`;
            responseText += `**More info:** ${change.url}\n\n`;
          }
        } else {
          responseText += `No specific breaking changes found for the query.\n\n`;
        }
        
        if (releaseNotesContent) {
          responseText += `## From Release Notes\n\n${releaseNotesContent}\n`;
        }
        
        responseText += `\n---\n**Tip:** Always check ${HA_BLOG_URL}/categories/release-notes/ for the latest changes.`;
        
        return makeCompatibleResponse({
          content: [createTextContent(responseText, { audience: ["assistant"], priority: 0.9 })],
        });
      }

      case "check_config_syntax": {
        const { yaml_config, integration } = args;
        sendLog("info", "docs", { action: "check_config_syntax", integration });
        
        const { deprecated, warnings, suggestions } = await checkConfigForDeprecations(yaml_config, integration);
        
        // Additional basic YAML validation hints
        const additionalWarnings = [];
        const additionalSuggestions = [];
        
        // Check for common YAML issues
        if (yaml_config.includes("\t")) {
          additionalWarnings.push("Tab characters detected. YAML requires spaces for indentation.");
          additionalSuggestions.push("Replace all tabs with spaces (2 spaces per indent level is standard for Home Assistant).");
        }
        
        if (!/^[a-z_]+:/m.test(yaml_config)) {
          additionalWarnings.push("No top-level key detected. Configuration should start with a domain key.");
        }
        
        // Check for common mistakes
        if (/: \|$/m.test(yaml_config)) {
          additionalSuggestions.push("Multi-line strings with '|' should have content on the following lines, indented.");
        }
        
        if (/entity_id:.*,/m.test(yaml_config)) {
          additionalSuggestions.push("Multiple entity_ids should be formatted as a YAML list, not comma-separated.");
        }
        
        const allWarnings = [...warnings, ...additionalWarnings];
        const allSuggestions = [...suggestions, ...additionalSuggestions];
        
        const docsUrl = integration 
          ? `${HA_INTEGRATIONS_URL}/${integration}/`
          : "https://www.home-assistant.io/docs/configuration/";
        
        const result = {
          valid: allWarnings.filter(w => w.includes("DEPRECATED")).length === 0,
          deprecated,
          warnings: allWarnings,
          suggestions: allSuggestions,
          docs_url: docsUrl,
        };
        
        let responseText = `# Configuration Syntax Check\n\n`;
        responseText += `**Status:** ${result.valid ? "OK" : "Issues Found"}\n`;
        responseText += `**Deprecated Syntax:** ${deprecated ? "Yes" : "No"}\n`;
        responseText += `**Docs:** ${docsUrl}\n\n`;
        
        if (allWarnings.length > 0) {
          responseText += `## Warnings\n\n`;
          for (const warning of allWarnings) {
            responseText += `- ${warning}\n`;
          }
          responseText += "\n";
        }
        
        if (allSuggestions.length > 0) {
          responseText += `## Suggestions\n\n`;
          for (const suggestion of allSuggestions) {
            responseText += `- ${suggestion}\n`;
          }
          responseText += "\n";
        }
        
        if (allWarnings.length === 0 && allSuggestions.length === 0) {
          responseText += "No issues detected in the configuration syntax.\n\n";
          responseText += "**Note:** This is a basic syntax check. Use `validate_config` for full Home Assistant validation.\n";
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(responseText, { audience: ["assistant"], priority: 0.9 })],
        });
      }

      // === SAFE CONFIG WRITER ===
      case "write_config_safe": {
        const { file_path, content, dry_run = false, validate_templates = true, confirm_deletions = false } = args;
        sendLog("info", "config", { action: "write_config_safe", file_path, dry_run });
        
        // Step 1: Validate and resolve the file path
        const resolvedPath = resolveConfigPath(file_path);
        if (!resolvedPath) {
          return makeCompatibleResponse({
            content: [createTextContent(
              `# Safe Config Write - BLOCKED\n\n` +
              `**Error:** Invalid or unsafe file path: \`${file_path}\`\n\n` +
              `The path must be relative to /homeassistant/ and cannot point to internal directories (.storage, .cloud, deps, etc.).\n` +
              `Example valid paths: \`configuration.yaml\`, \`automations.yaml\`, \`packages/lights.yaml\``,
              { audience: ["user", "assistant"], priority: 1.0 }
            )],
            isError: true,
          });
        }
        
        // Step 2: Run deprecation checks on the content
        const { deprecated, warnings: depWarnings, suggestions: depSuggestions } = await checkConfigForDeprecations(content);
        
        // Step 3: Run structural YAML checks
        const structuralIssues = validateYamlStructure(content);
        
        // Step 4: Basic YAML lint checks (same as check_config_syntax)
        const lintWarnings = [];
        if (content.includes("\t")) {
          lintWarnings.push("Tab characters detected. YAML requires spaces for indentation.");
        }
        if (/: \|$/m.test(content)) {
          lintWarnings.push("Multi-line strings with '|' should have content on the following lines, indented.");
        }
        if (/entity_id:.*,/m.test(content)) {
          lintWarnings.push("Multiple entity_ids should be formatted as a YAML list, not comma-separated.");
        }
        
        // Step 5: Check HA repair issues for relevant warnings
        let repairWarnings = [];
        try {
          // Extract integration domains from the YAML content
          const domainMatches = content.match(/^([a-z_]+):/gm);
          const domains = domainMatches
            ? [...new Set(domainMatches.map(m => m.replace(":", "").trim()))]
            : [];
          
          if (domains.length > 0) {
            const repairs = await getRepairsForDomains(domains);
            for (const issue of repairs) {
              const breaksIn = issue.breaks_in_ha_version ? ` (breaks in ${issue.breaks_in_ha_version})` : "";
              const url = issue.learn_more_url ? ` See: ${issue.learn_more_url}` : "";
              repairWarnings.push(
                `[HA REPAIR - ${issue.severity || "warning"}] ${issue.domain}: ${issue.translation_key || issue.issue_id}${breaksIn}${url}`
              );
            }
          }
        } catch (_) { /* non-critical — repairs check is best-effort */ }
        
        // Step 6: Validate Jinja2 templates through HA's template engine
        let templateResults = [];
        if (validate_templates) {
          try {
            templateResults = await extractAndValidateTemplates(content);
          } catch (error) {
            sendLog("warning", "config", { action: "template_validation_failed", error: error.message });
            templateResults = [{ template: "(all)", status: "skipped", reason: `Template validation unavailable: ${error.message}` }];
          }
        }
        
        const templateErrors = templateResults.filter(r => r.status === "error");
        const structuralErrors = structuralIssues.filter(i => i.severity === "error");
        
        // Step 6b: Check if writing would reduce entries in list-based config files
        // (automations.yaml, scripts.yaml, scenes.yaml are YAML lists where accidental
        // overwrites destroy existing entries — block unless explicitly allowed)
        const LIST_CONFIG_FILES = ["automations.yaml", "scripts.yaml", "scenes.yaml"];
        const isListConfig = LIST_CONFIG_FILES.some(f => resolvedPath.endsWith("/" + f));
        let entryReductionError = null;

        if (isListConfig && !confirm_deletions && existsSync(resolvedPath)) {
          try {
            const existingContent = readFileSync(resolvedPath, "utf-8");
            const existingCount = (existingContent.match(/^- /gm) || []).length;
            const newCount = (content.match(/^- /gm) || []).length;
            if (existingCount > 0 && newCount < existingCount) {
              entryReductionError = { existingCount, newCount, removed: existingCount - newCount };
            }
          } catch (_) { /* best effort — don't block if we can't read the existing file */ }
        }

        // Step 6c: Check for pre-write blocking errors (template errors + structural errors + entry reduction)
        const hasBlockingErrors = templateErrors.length > 0 || structuralErrors.length > 0 || entryReductionError !== null;
        
        // If dry_run, report results without touching disk
        if (dry_run) {
          let responseText = `# Safe Config Write - Dry Run\n\n`;
          responseText += `**File:** \`${file_path}\`\n`;
          responseText += `**Mode:** Validation only (no file changes)\n\n`;
          
          if (hasBlockingErrors) {
            responseText += `## BLOCKING ERRORS (must fix before writing)\n\n`;
            for (const te of templateErrors) {
              responseText += `- **Template Error:** \`${te.template}\` - ${te.error}\n`;
            }
            for (const si of structuralErrors) {
              responseText += `- **Structural Error:** ${si.message}\n`;
            }
            if (entryReductionError) {
              responseText += `- **Entry Reduction Blocked:** The existing file has ${entryReductionError.existingCount} top-level entries but the new content only has ${entryReductionError.newCount} (${entryReductionError.removed} would be lost).\n`;
              responseText += `  **Action:** Read the existing \`${file_path}\` first, then include ALL existing entries plus your new entry in the content you write.\n`;
              responseText += `  If you intentionally want to remove entries, pass \`confirm_deletions: true\`.\n`;
            }
            responseText += `\n`;
          }
          
          if (depWarnings.length > 0) {
            responseText += `## Deprecation Warnings\n\n`;
            for (const w of depWarnings) responseText += `- ${w}\n`;
            responseText += `\n`;
          }
          
          if (lintWarnings.length > 0) {
            responseText += `## Lint Warnings\n\n`;
            for (const w of lintWarnings) responseText += `- ${w}\n`;
            responseText += `\n`;
          }
          
          const structuralWarnings = structuralIssues.filter(i => i.severity === "warning");
          if (structuralWarnings.length > 0) {
            responseText += `## Structural Warnings\n\n`;
            for (const w of structuralWarnings) responseText += `- ${w.message}\n`;
            responseText += `\n`;
          }
          
          if (repairWarnings.length > 0) {
            responseText += `## HA Repair Issues (from your installation)\n\n`;
            for (const w of repairWarnings) responseText += `- ${w}\n`;
            responseText += `\n`;
          }
          
          if (templateResults.length > 0) {
            const validTemplates = templateResults.filter(r => r.status === "valid");
            const skippedTemplates = templateResults.filter(r => r.status === "skipped");
            responseText += `## Template Validation\n\n`;
            responseText += `- Valid: ${validTemplates.length}\n`;
            responseText += `- Errors: ${templateErrors.length}\n`;
            responseText += `- Skipped (runtime context): ${skippedTemplates.length}\n\n`;
          }
          
          if (depSuggestions.length > 0) {
            responseText += `## Suggestions\n\n`;
            for (const s of depSuggestions) responseText += `- ${s}\n`;
            responseText += `\n`;
          }
          
          const dryRunPassed = !hasBlockingErrors;
          responseText += `---\n**Result:** ${dryRunPassed ? "PASSED - Safe to write" : "FAILED - Fix errors above before writing"}\n`;
          
          if (dryRunPassed && (depWarnings.length > 0 || lintWarnings.length > 0 || repairWarnings.length > 0)) {
            responseText += `**Note:** Warnings were found but won't block writing. Consider addressing them for best practices.\n`;
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["assistant"], priority: 1.0 })],
          });
        }
        
        // Step 7: If blocking errors exist, refuse to write
        if (hasBlockingErrors) {
          let responseText = `# Safe Config Write - REFUSED\n\n`;
          responseText += `**File:** \`${file_path}\`\n`;
          responseText += `**Reason:** Blocking errors detected. File was NOT written.\n\n`;
          responseText += `## Errors (must fix)\n\n`;
          for (const te of templateErrors) {
            responseText += `- **Template Error:** \`${te.template}\` - ${te.error}\n`;
          }
          for (const si of structuralErrors) {
            responseText += `- **Structural Error:** ${si.message}\n`;
          }
          if (entryReductionError) {
            responseText += `- **Entry Reduction Blocked:** The existing file has ${entryReductionError.existingCount} top-level entries but the new content only has ${entryReductionError.newCount} (${entryReductionError.removed} would be permanently lost).\n`;
            responseText += `\n**Action:** Read the existing \`${file_path}\` first, then include ALL existing entries plus your new entry in the content you write. If you intentionally want to remove entries, pass \`confirm_deletions: true\`.\n`;
          } else {
            responseText += `\n**Action:** Fix the errors above and retry. Use \`dry_run: true\` to validate before writing.\n`;
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["assistant"], priority: 1.0 })],
          });
        }
        
        // Step 8: Backup existing file (if it exists)
        const backupPath = resolvedPath + ".bak";
        let hadExistingFile = false;
        try {
          if (existsSync(resolvedPath)) {
            copyFileSync(resolvedPath, backupPath);
            hadExistingFile = true;
            sendLog("info", "config", { action: "backup_created", path: backupPath });
          }
        } catch (error) {
          return makeCompatibleResponse({
            content: [createTextContent(
              `# Safe Config Write - ERROR\n\n` +
              `**Error:** Could not create backup of existing file: ${error.message}\n` +
              `File was NOT modified.`,
              { audience: ["user", "assistant"], priority: 1.0 }
            )],
            isError: true,
          });
        }
        
        // Step 9: Write the new content
        try {
          // Ensure parent directory exists
          const parentDir = dirname(resolvedPath);
          if (!existsSync(parentDir)) {
            mkdirSync(parentDir, { recursive: true });
          }
          writeFileSync(resolvedPath, content, "utf-8");
          sendLog("info", "config", { action: "file_written", path: resolvedPath });
        } catch (error) {
          // Restore backup if write failed
          if (hadExistingFile) {
            try { copyFileSync(backupPath, resolvedPath); } catch (_) { /* best effort */ }
          }
          return makeCompatibleResponse({
            content: [createTextContent(
              `# Safe Config Write - ERROR\n\n` +
              `**Error:** Could not write file: ${error.message}\n` +
              `${hadExistingFile ? "Original file has been restored from backup." : "No file was created."}`,
              { audience: ["user", "assistant"], priority: 1.0 }
            )],
            isError: true,
          });
        }
        
        // Step 10: Run HA's full config validation
        let validationResult = "skipped";
        let validationErrors = "";
        let backupRestored = false;
        
        try {
          const haCheck = await callHA("/config/core/check_config", "POST");
          validationResult = haCheck.result || "valid";
          validationErrors = haCheck.errors || "";
          
          if (validationResult === "invalid") {
            sendLog("warning", "config", { action: "validation_failed", errors: validationErrors });
            
            // Restore the backup
            if (hadExistingFile) {
              try {
                copyFileSync(backupPath, resolvedPath);
                backupRestored = true;
                sendLog("info", "config", { action: "backup_restored", path: resolvedPath });
              } catch (restoreError) {
                sendLog("error", "config", { action: "backup_restore_failed", error: restoreError.message });
              }
            } else {
              // No original file existed - remove the invalid one
              try {
                unlinkSync(resolvedPath);
                backupRestored = true;
              } catch (_) { /* best effort */ }
            }
          }
        } catch (error) {
          sendLog("error", "config", { action: "validation_call_failed", error: error.message });
          validationResult = "skipped";
          validationErrors = `Could not run HA config check: ${error.message}`;
          
          // Cannot confirm the config is valid — restore backup same as "invalid"
          if (hadExistingFile) {
            try {
              copyFileSync(backupPath, resolvedPath);
              backupRestored = true;
              sendLog("info", "config", { action: "backup_restored", path: resolvedPath });
            } catch (restoreError) {
              sendLog("error", "config", { action: "backup_restore_failed", error: restoreError.message });
            }
          } else {
            // No original file existed — remove the unvalidated one
            try {
              unlinkSync(resolvedPath);
              backupRestored = true;
            } catch (_) { /* best effort */ }
          }
        }
        
        // Clean up backup only on confirmed valid result
        if (validationResult === "valid" && hadExistingFile) {
          try { unlinkSync(backupPath); } catch (_) { /* best effort */ }
        }
        
        // Step 11: Build response
        const success = validationResult === "valid";
        let responseText = `# Safe Config Write - ${success ? "SUCCESS" : "FAILED"}\n\n`;
        responseText += `**File:** \`${file_path}\`\n`;
        responseText += `**HA Config Validation:** ${validationResult}\n`;
        responseText += `**File Written:** ${success ? "Yes" : "No (restored original)"}\n\n`;
        
        if (!success) {
          responseText += `## Validation Errors\n\n`;
          responseText += `\`\`\`\n${validationErrors}\n\`\`\`\n\n`;
          responseText += `**The original file has been restored.** Fix the errors above and retry.\n\n`;
          
          // Include any error log entries that might help
          try {
            const log = await callHA("/core/api/error_log");
            const recentLines = log.split("\n").slice(-20).join("\n");
            if (recentLines.trim()) {
              responseText += `## Recent Error Log\n\n\`\`\`\n${recentLines}\n\`\`\`\n\n`;
            }
          } catch (_) { /* best effort */ }
        }
        
        if (depWarnings.length > 0) {
          responseText += `## Deprecation Warnings\n\n`;
          for (const w of depWarnings) responseText += `- ${w}\n`;
          responseText += `\n`;
        }
        
        if (lintWarnings.length > 0) {
          responseText += `## Lint Warnings\n\n`;
          for (const w of lintWarnings) responseText += `- ${w}\n`;
          responseText += `\n`;
        }
        
        const structuralWarnings = structuralIssues.filter(i => i.severity === "warning");
        if (structuralWarnings.length > 0) {
          responseText += `## Structural Warnings\n\n`;
          for (const w of structuralWarnings) responseText += `- ${w.message}\n`;
          responseText += `\n`;
        }
        
        if (repairWarnings.length > 0) {
          responseText += `## HA Repair Issues (from your installation)\n\n`;
          for (const w of repairWarnings) responseText += `- ${w}\n`;
          responseText += `\n`;
        }
        
        if (templateResults.length > 0) {
          const validCount = templateResults.filter(r => r.status === "valid").length;
          const skippedCount = templateResults.filter(r => r.status === "skipped").length;
          responseText += `## Template Validation: ${validCount} valid, ${skippedCount} skipped (runtime context)\n\n`;
        }
        
        if (depSuggestions.length > 0) {
          responseText += `## Suggestions\n\n`;
          for (const s of depSuggestions) responseText += `- ${s}\n`;
          responseText += `\n`;
        }
        
        if (success) {
          responseText += `---\n**Config is valid and has been written to disk.** You can reload or restart HA to apply changes.\n`;
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 1.0 })],
          ...((!success) && { isError: true }),
        });
      }

      // === UPDATE MANAGEMENT ===
      case "get_available_updates": {
        const component = args?.component || "all";
        sendLog("info", "updates", { action: "check_updates", component });
        
        const updates = [];
        
        // Get Core info
        if (component === "all" || component === "core") {
          try {
            const coreInfo = await callSupervisor("/core/info");
            updates.push({
              type: "core",
              name: "Home Assistant Core",
              installed: coreInfo.version,
              latest: coreInfo.version_latest,
              update_available: coreInfo.update_available,
            });
          } catch (e) {
            sendLog("warning", "updates", { action: "core_check_failed", error: e.message });
          }
        }
        
        // Get OS info (only on HAOS)
        if (component === "all" || component === "os") {
          try {
            const osInfo = await callSupervisor("/os/info");
            if (osInfo.version) {
              updates.push({
                type: "os",
                name: "Home Assistant OS",
                installed: osInfo.version,
                latest: osInfo.version_latest,
                update_available: osInfo.update_available,
              });
            }
          } catch (e) {
            // OS info not available on supervised installs
            sendLog("debug", "updates", { action: "os_not_available" });
          }
        }
        
        // Get Supervisor info
        if (component === "all" || component === "supervisor") {
          try {
            const supInfo = await callSupervisor("/supervisor/info");
            updates.push({
              type: "supervisor",
              name: "Home Assistant Supervisor",
              installed: supInfo.version,
              latest: supInfo.version_latest,
              update_available: supInfo.update_available,
            });
          } catch (e) {
            sendLog("warning", "updates", { action: "supervisor_check_failed", error: e.message });
          }
        }
        
        // Get add-on updates
        if (component === "all" || component === "addons") {
          try {
            const addonsInfo = await callSupervisor("/addons");
            const installedAddons = addonsInfo.addons.filter(a => a.installed);
            
            for (const addon of installedAddons) {
              updates.push({
                type: "addon",
                slug: addon.slug,
                name: addon.name,
                installed: addon.version,
                latest: addon.version_latest,
                update_available: addon.update_available,
              });
            }
          } catch (e) {
            sendLog("warning", "updates", { action: "addons_check_failed", error: e.message });
          }
        }
        
        // Format output
        const pendingUpdates = updates.filter(u => u.update_available);
        let responseText = `# Available Updates\n\n`;
        responseText += `**Checked:** ${new Date().toISOString()}\n`;
        responseText += `**Updates Available:** ${pendingUpdates.length}\n\n`;
        
        if (pendingUpdates.length > 0) {
          responseText += `## Pending Updates\n\n`;
          for (const u of pendingUpdates) {
            responseText += `- **${u.name}** ${u.type === 'addon' ? `(${u.slug})` : ''}: ${u.installed} → ${u.latest}\n`;
          }
          responseText += `\n`;
        }
        
        responseText += `## All Components\n\n`;
        responseText += `| Component | Type | Installed | Latest | Update |\n`;
        responseText += `|-----------|------|-----------|--------|--------|\n`;
        for (const u of updates) {
          responseText += `| ${u.name} | ${u.type} | ${u.installed} | ${u.latest} | ${u.update_available ? '⬆️ Yes' : '✓ Current'} |\n`;
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.9 })],
        });
      }

      case "get_addon_changelog": {
        const { addon_slug } = args;
        sendLog("info", "updates", { action: "get_changelog", addon: addon_slug });
        
        try {
          // Get add-on info first
          const addonInfo = await callSupervisor(`/addons/${addon_slug}/info`);
          const changelog = await callSupervisor(`/addons/${addon_slug}/changelog`);
          
          let responseText = `# Changelog: ${addonInfo.name}\n\n`;
          responseText += `**Current Version:** ${addonInfo.version}\n`;
          responseText += `**Latest Version:** ${addonInfo.version_latest}\n`;
          responseText += `**Update Available:** ${addonInfo.update_available ? 'Yes' : 'No'}\n\n`;
          responseText += `---\n\n`;
          responseText += changelog;
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.8 })],
          });
        } catch (e) {
          throw new Error(`Failed to get changelog for '${addon_slug}': ${e.message}`);
        }
      }

      case "update_component": {
        const { component, addon_slug, backup = true } = args;
        sendLog("notice", "updates", { action: "initiate_update", component, addon_slug, backup });
        
        // Prevent self-update
        if (component === "addon" && addon_slug === "local_ha_opencode") {
          throw new Error("Cannot update OpenCode from within itself. The container will be stopped during update. Please use the Home Assistant UI to update this app.");
        }
        
        let endpoint;
        let payload = { background: true };
        let componentName;
        
        switch (component) {
          case "core":
            endpoint = "/core/update";
            payload.backup = backup;
            componentName = "Home Assistant Core";
            break;
          case "os":
            endpoint = "/os/update";
            componentName = "Home Assistant OS";
            break;
          case "supervisor":
            endpoint = "/supervisor/update";
            componentName = "Supervisor";
            break;
          case "addon":
            if (!addon_slug) {
              throw new Error("addon_slug is required when component is 'addon'");
            }
            endpoint = `/store/addons/${addon_slug}/update`;
            payload.backup = backup;
            componentName = addon_slug;
            break;
          default:
            throw new Error(`Unknown component type: ${component}`);
        }
        
        try {
          const result = await callSupervisor(endpoint, "POST", payload);
          
          // Background mode returns job_id
          const jobId = result?.job_id || result;
          
          let responseText = `# Update Initiated\n\n`;
          responseText += `**Component:** ${componentName}\n`;
          responseText += `**Job ID:** ${jobId}\n`;
          responseText += `**Backup:** ${backup ? 'Yes' : 'No'}\n\n`;
          responseText += `## Monitor Progress\n\n`;
          responseText += `Use \`get_update_progress\` with job_id \`${jobId}\` to monitor the update.\n\n`;
          responseText += `**Example:** \`get_update_progress({ job_id: "${jobId}" })\`\n`;
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 1.0 })],
          });
        } catch (e) {
          throw new Error(`Failed to initiate update for ${componentName}: ${e.message}`);
        }
      }

      case "get_update_progress": {
        const { job_id } = args;
        sendLog("debug", "updates", { action: "check_progress", job_id });
        
        try {
          const job = await callSupervisor(`/jobs/${job_id}`);
          
          let statusEmoji;
          if (job.done) {
            statusEmoji = job.errors ? "❌" : "✅";
          } else {
            statusEmoji = "⏳";
          }
          
          let responseText = `# Job Progress: ${job_id}\n\n`;
          responseText += `**Status:** ${statusEmoji} ${job.done ? (job.errors ? 'Failed' : 'Completed') : 'In Progress'}\n`;
          responseText += `**Name:** ${job.name}\n`;
          responseText += `**Progress:** ${job.progress || 0}%\n`;
          
          if (job.stage) {
            responseText += `**Stage:** ${job.stage}\n`;
          }
          
          if (job.reference) {
            responseText += `**Reference:** ${job.reference}\n`;
          }
          
          responseText += `\n`;
          
          // Progress bar visualization
          const progressBar = "█".repeat(Math.floor((job.progress || 0) / 5)) + "░".repeat(20 - Math.floor((job.progress || 0) / 5));
          responseText += `**[${progressBar}] ${job.progress || 0}%**\n\n`;
          
          if (job.child_jobs && job.child_jobs.length > 0) {
            responseText += `## Sub-tasks\n\n`;
            for (const child of job.child_jobs) {
              const childStatus = child.done ? (child.errors ? "❌" : "✅") : "⏳";
              responseText += `- ${childStatus} ${child.name}: ${child.progress || 0}%\n`;
            }
            responseText += `\n`;
          }
          
          if (job.errors) {
            responseText += `## Errors\n\n`;
            responseText += `\`\`\`\n${JSON.stringify(job.errors, null, 2)}\n\`\`\`\n`;
          }
          
          if (!job.done) {
            responseText += `---\n\n*Poll again in a few seconds to see updated progress.*\n`;
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.9 })],
          });
        } catch (e) {
          throw new Error(`Failed to get job progress: ${e.message}`);
        }
      }

      case "get_running_jobs": {
        sendLog("debug", "updates", { action: "list_jobs" });
        
        try {
          const jobsInfo = await callSupervisor("/jobs/info");
          const jobs = jobsInfo.jobs || [];
          
          let responseText = `# Supervisor Jobs\n\n`;
          responseText += `**Total Jobs:** ${jobs.length}\n\n`;
          
          if (jobs.length === 0) {
            responseText += `*No running or recent jobs found.*\n`;
          } else {
            const runningJobs = jobs.filter(j => !j.done);
            const completedJobs = jobs.filter(j => j.done);
            
            if (runningJobs.length > 0) {
              responseText += `## Running Jobs\n\n`;
              responseText += `| Job ID | Name | Progress | Stage |\n`;
              responseText += `|--------|------|----------|-------|\n`;
              for (const job of runningJobs) {
                responseText += `| ${job.uuid.substring(0, 8)}... | ${job.name} | ${job.progress || 0}% | ${job.stage || '-'} |\n`;
              }
              responseText += `\n`;
            }
            
            if (completedJobs.length > 0) {
              responseText += `## Completed Jobs\n\n`;
              responseText += `| Job ID | Name | Status |\n`;
              responseText += `|--------|------|--------|\n`;
              for (const job of completedJobs.slice(0, 10)) {
                const status = job.errors ? "❌ Failed" : "✅ Success";
                responseText += `| ${job.uuid.substring(0, 8)}... | ${job.name} | ${status} |\n`;
              }
            }
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.7 })],
          });
        } catch (e) {
          throw new Error(`Failed to list jobs: ${e.message}`);
        }
      }

      // === ESPHOME INTEGRATION ===
      case "esphome_list_devices": {
        sendLog("info", "esphome", { action: "list_devices" });
        
        // Discover ESPHome add-on
        const esphome = await discoverESPHome();
        if (!esphome.ok) {
          const d = esphome.diagnostics;
          let msg = `ESPHome discovery failed: ${esphome.error}\n\n`;
          msg += `## Discovery Steps\n`;
          for (const s of d.steps) {
            msg += `- **${s.name}**: ${s.status}${s.detail ? ` — ${typeof s.detail === "object" ? JSON.stringify(s.detail) : s.detail}` : ""}\n`;
          }
          if (d.esphomeSlugs) msg += `\nESPHome-matching slugs: ${JSON.stringify(d.esphomeSlugs)}`;
          if (d.networkFallback) msg += `\nNetwork fallback data: ${JSON.stringify(d.networkFallback, null, 2)}`;
          throw new Error(msg);
        }
        
        if (esphome.state !== "started") {
          throw new Error(`ESPHome add-on is not running (current state: ${esphome.state}). Please start the ESPHome add-on first.`);
        }
        
        try {
          const devices = await getESPHomeDevices(esphome.url, esphome.ingressSession);
          
          let responseText = `# ESPHome Devices\n\n`;
          responseText += `**ESPHome Version:** ${esphome.version}\n`;
          responseText += `**Add-on:** ${esphome.name} (${esphome.slug})\n\n`;
          
          const configured = devices.configured || [];
          const importable = devices.importable || [];
          
          if (configured.length === 0 && importable.length === 0) {
            responseText += `*No ESPHome devices configured yet.*\n\n`;
            responseText += `Create a new device in the ESPHome dashboard to get started.\n`;
          } else {
            if (configured.length > 0) {
              responseText += `## Configured Devices (${configured.length})\n\n`;
              responseText += `| Device | Platform | Current | Deployed | Status |\n`;
              responseText += `|--------|----------|---------|----------|--------|\n`;
              
              for (const device of configured) {
                const needsUpdate = device.current_version !== device.deployed_version;
                const status = needsUpdate ? "⬆️ Update available" : "✓ Current";
                responseText += `| ${device.name} | ${device.target_platform} | ${device.current_version || '-'} | ${device.deployed_version || '-'} | ${status} |\n`;
              }
              responseText += `\n`;
            }
            
            if (importable.length > 0) {
              responseText += `## Discoverable Devices (${importable.length})\n\n`;
              responseText += `These devices can be adopted into ESPHome:\n\n`;
              for (const device of importable) {
                responseText += `- **${device.name}** (${device.project_name} v${device.project_version}) - ${device.network}\n`;
              }
            }
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.8 })],
          });
        } catch (e) {
          throw new Error(`Failed to get ESPHome devices: ${e.message}`);
        }
      }

      case "esphome_compile": {
        const { device } = args;
        sendLog("info", "esphome", { action: "compile", device });
        
        // Discover ESPHome add-on
        const esphome = await discoverESPHome();
        if (!esphome.ok) {
          const d = esphome.diagnostics;
          let msg = `ESPHome discovery failed: ${esphome.error}\n\nSteps: `;
          msg += d.steps.map(s => `${s.name}=${s.status}`).join(", ");
          throw new Error(msg);
        }
        
        if (esphome.state !== "started") {
          throw new Error(`ESPHome add-on is not running (current state: ${esphome.state}). Please start the ESPHome add-on first.`);
        }
        
        // Ensure device has .yaml extension
        const configuration = device.endsWith(".yaml") ? device : `${device}.yaml`;
        
        try {
          const result = await streamESPHomeLogs(
            esphome.url,
            "compile",
            { configuration },
            null,
            600000,  // 10 minute timeout for compilation
            esphome.ingressSession
          );
          
          // Format the output
          let responseText = `# ESPHome Compile: ${device}\n\n`;
          responseText += `**Status:** ${result.success ? "✅ Success" : "❌ Failed"}\n`;
          responseText += `**Duration:** ${result.duration}\n`;
          responseText += `**Exit Code:** ${result.code}\n\n`;
          
          responseText += `## Build Log\n\n`;
          responseText += "```\n";
          
          // Truncate logs if too long (keep last 200 lines for errors, first 50 for context)
          const logs = result.logs;
          if (logs.length > 300) {
            responseText += logs.slice(0, 50).join("\n");
            responseText += `\n\n... (${logs.length - 250} lines omitted) ...\n\n`;
            responseText += logs.slice(-200).join("\n");
          } else {
            responseText += logs.join("\n");
          }
          
          responseText += "\n```\n";
          
          if (!result.success) {
            responseText += `\n## Troubleshooting\n\n`;
            responseText += `The compilation failed. Check the build log above for errors.\n`;
            responseText += `Common issues:\n`;
            responseText += `- Syntax errors in YAML configuration\n`;
            responseText += `- Missing or incompatible components\n`;
            responseText += `- Platform-specific issues\n`;
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.9 })],
          });
        } catch (e) {
          throw new Error(`ESPHome compile failed: ${e.message}`);
        }
      }

      case "esphome_upload": {
        const { device, port } = args;
        sendLog("info", "esphome", { action: "upload", device, port });
        
        // Discover ESPHome add-on
        const esphome = await discoverESPHome();
        if (!esphome.ok) {
          const d = esphome.diagnostics;
          let msg = `ESPHome discovery failed: ${esphome.error}\n\nSteps: `;
          msg += d.steps.map(s => `${s.name}=${s.status}`).join(", ");
          throw new Error(msg);
        }
        
        if (esphome.state !== "started") {
          throw new Error(`ESPHome add-on is not running (current state: ${esphome.state}). Please start the ESPHome add-on first.`);
        }
        
        // Ensure device has .yaml extension
        const configuration = device.endsWith(".yaml") ? device : `${device}.yaml`;
        
        try {
          const result = await streamESPHomeLogs(
            esphome.url,
            "upload",
            { configuration, port },
            null,
            300000,  // 5 minute timeout for upload
            esphome.ingressSession
          );
          
          // Format the output
          let responseText = `# ESPHome Upload: ${device}\n\n`;
          responseText += `**Status:** ${result.success ? "✅ Success" : "❌ Failed"}\n`;
          responseText += `**Target:** ${port}\n`;
          responseText += `**Duration:** ${result.duration}\n`;
          responseText += `**Exit Code:** ${result.code}\n\n`;
          
          responseText += `## Upload Log\n\n`;
          responseText += "```\n";
          
          // Truncate logs if too long
          const logs = result.logs;
          if (logs.length > 200) {
            responseText += logs.slice(0, 30).join("\n");
            responseText += `\n\n... (${logs.length - 130} lines omitted) ...\n\n`;
            responseText += logs.slice(-100).join("\n");
          } else {
            responseText += logs.join("\n");
          }
          
          responseText += "\n```\n";
          
          if (result.success) {
            responseText += `\n## Next Steps\n\n`;
            responseText += `The firmware has been uploaded successfully. The device should restart automatically.\n`;
            responseText += `You can verify the device is online using \`esphome_list_devices\`.\n`;
          } else {
            responseText += `\n## Troubleshooting\n\n`;
            responseText += `The upload failed. Common issues:\n`;
            responseText += `- Device not reachable (check network connectivity)\n`;
            responseText += `- Wrong port/IP address\n`;
            responseText += `- Device in deep sleep mode\n`;
            responseText += `- Firewall blocking OTA port (default: 3232)\n`;
          }
          
          return makeCompatibleResponse({
            content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.9 })],
          });
        } catch (e) {
          throw new Error(`ESPHome upload failed: ${e.message}`);
        }
      }

      // === FIRMWARE UPDATE MONITORING ===
      case "watch_firmware_update": {
        const { entity_id, start_update = false } = args;
        sendLog("info", "firmware-update", { action: "watch", entity_id, start_update });
        
        // Validate entity_id format
        if (!entity_id.startsWith("update.")) {
          throw new Error(`Invalid entity_id: ${entity_id}. Must be an update entity (update.xxx)`);
        }
        
        const formatTime = (date) => date.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        
        // Get current state
        let response = await callApi(`/states/${entity_id}`);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Entity ${entity_id} not found: ${errorText}`);
        }
        
        let entityState = await response.json();
        const attrs = entityState.attributes || {};
        const installedVersion = attrs.installed_version || "unknown";
        const latestVersion = attrs.latest_version || "unknown";
        const deviceName = attrs.friendly_name || entity_id.replace("update.", "");
        const inProgress = attrs.in_progress === true;
        const progress = attrs.update_percentage;
        const currentState = entityState.state;
        
        let responseText = `# Firmware Update: ${deviceName}\n\n`;
        responseText += `**Entity:** \`${entity_id}\`\n`;
        responseText += `**Time:** ${formatTime(new Date())}\n\n`;
        
        // Determine status and take action
        let statusEmoji, statusText;
        
        if (inProgress) {
          statusEmoji = "⏳";
          statusText = "Update In Progress";
          responseText += `## ${statusEmoji} ${statusText}\n\n`;
          responseText += `| Field | Value |\n`;
          responseText += `|-------|-------|\n`;
          responseText += `| Installed Version | ${installedVersion} |\n`;
          responseText += `| Target Version | ${latestVersion} |\n`;
          if (progress !== null && progress !== undefined) {
            const filled = Math.floor(progress / 5);
            const empty = 20 - filled;
            responseText += `| Progress | ${"█".repeat(filled)}${"░".repeat(empty)} ${progress}% |\n`;
          } else {
            responseText += `| Progress | Compiling/Installing (no percentage reported) |\n`;
          }
          responseText += `\n**The update is running.** Call this tool again in a few seconds to check progress.\n`;
          
        } else if (currentState === "unavailable") {
          statusEmoji = "🔄";
          statusText = "Device Rebooting";
          responseText += `## ${statusEmoji} ${statusText}\n\n`;
          responseText += `The device is currently unavailable - likely rebooting after firmware update.\n\n`;
          responseText += `**Wait a minute and call this tool again** to check if the device comes back online.\n`;
          
        } else if (currentState === "off") {
          statusEmoji = "✅";
          statusText = "Up to Date";
          responseText += `## ${statusEmoji} ${statusText}\n\n`;
          responseText += `| Field | Value |\n`;
          responseText += `|-------|-------|\n`;
          responseText += `| Installed Version | ${installedVersion} |\n`;
          responseText += `| Latest Version | ${latestVersion} |\n`;
          responseText += `\nNo update available. The device is running the latest version.\n`;
          
        } else if (currentState === "on") {
          // Update is available
          if (start_update) {
            // Start the update
            const serviceResponse = await callApi("/services/update/install", {
              method: "POST",
              body: JSON.stringify({ entity_id }),
            });
            
            if (!serviceResponse.ok) {
              const errorText = await serviceResponse.text();
              throw new Error(`Failed to start update: ${errorText}`);
            }
            
            statusEmoji = "🚀";
            statusText = "Update Started";
            responseText += `## ${statusEmoji} ${statusText}\n\n`;
            responseText += `| Field | Value |\n`;
            responseText += `|-------|-------|\n`;
            responseText += `| Current Version | ${installedVersion} |\n`;
            responseText += `| Target Version | ${latestVersion} |\n`;
            responseText += `\n**Update has been initiated!**\n\n`;
            responseText += `The device will now download and install the firmware. This typically takes 1-5 minutes.\n\n`;
            responseText += `**Call this tool again** (without \`start_update\`) to monitor progress.\n`;
          } else {
            statusEmoji = "⬆️";
            statusText = "Update Available";
            responseText += `## ${statusEmoji} ${statusText}\n\n`;
            responseText += `| Field | Value |\n`;
            responseText += `|-------|-------|\n`;
            responseText += `| Installed Version | ${installedVersion} |\n`;
            responseText += `| Available Version | ${latestVersion} |\n`;
            responseText += `\nAn update is available but not yet started.\n\n`;
            responseText += `**To start the update**, call this tool with \`start_update: true\`.\n`;
          }
        } else {
          statusEmoji = "❓";
          statusText = `Unknown State: ${currentState}`;
          responseText += `## ${statusEmoji} ${statusText}\n\n`;
          responseText += `The device is in an unexpected state. Check the Home Assistant UI for more details.\n`;
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.9 })],
        });
      }

      // === HAB CLI INTEGRATION ===
      case "hab_run": {
        const { command } = args;
        if (!command || typeof command !== "string") {
          throw new Error("command parameter is required and must be a string");
        }
        
        // Security: block dangerous commands
        const lowerCmd = command.toLowerCase().trim();
        if (lowerCmd.startsWith("auth ") || lowerCmd === "auth") {
          throw new Error("Auth commands are not needed - hab is pre-authenticated via Supervisor token.");
        }
        if (lowerCmd.startsWith("update") && !lowerCmd.startsWith("update ")) {
          throw new Error("Self-update of hab is not supported inside the container. hab is updated with the add-on.");
        }
        
        sendLog("info", "hab", { action: "run_command", command });
        
        // Parse command string into args array for execFile (safe, no shell injection)
        const cmdArgs = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')/g) || [];
        // Strip quotes from args
        const cleanArgs = cmdArgs.map(arg => arg.replace(/^["']|["']$/g, ""));
        
        // For esphome subcommands, pre-discover the ESPHome ingress URL so
        // hab can skip its own (broken direct-connection) discovery and route
        // through the Supervisor ingress proxy instead.
        let esphomeEnv = {};
        if (lowerCmd.startsWith("esphome ") || lowerCmd === "esphome") {
          try {
            const esphome = await discoverESPHome();
            if (esphome.ok && esphome.url && esphome.ingressSession) {
              esphomeEnv.HAB_ESPHOME_URL = esphome.url;
              esphomeEnv.HAB_ESPHOME_SESSION = esphome.ingressSession;
            } else if (!esphome.ok) {
              sendLog("warning", "hab", {
                action: "esphome_prediscovery_failed",
                error: esphome.error,
                steps: esphome.diagnostics?.steps,
              });
            }
          } catch (e) {
            sendLog("warning", "hab", { action: "esphome_prediscovery_failed", error: e.message });
          }
        }
        
        const result = await new Promise((resolvePromise, rejectPromise) => {
          const proc = execFile("/usr/local/bin/hab", cleanArgs, {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            env: {
              ...process.env,
              SUPERVISOR_TOKEN: SUPERVISOR_TOKEN,
              HAB_URL: "http://supervisor/core",
              HAB_TOKEN: SUPERVISOR_TOKEN,
              ...(HA_ACCESS_TOKEN ? { HA_ACCESS_TOKEN } : {}),
              ...esphomeEnv,
            },
          }, (error, stdout, stderr) => {
            if (error) {
              // hab may return non-zero exit code with useful output
              const output = stdout || stderr || error.message;
              rejectPromise(new Error(`hab command failed: ${output}`));
            } else {
              resolvePromise(stdout);
            }
          });
        });
        
        // Try to parse as JSON for structured output
        let responseText;
        try {
          const parsed = JSON.parse(result);
          responseText = "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
        } catch {
          // Not JSON, return as plain text
          responseText = result.trim();
        }
        
        return makeCompatibleResponse({
          content: [createTextContent(responseText, { audience: ["user", "assistant"], priority: 0.7 })],
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    sendLog("error", "mcp-server", { action: "tool_error", tool: name, error: error.message });
    return makeCompatibleResponse({
      content: [createTextContent(`Error: ${error.message}`, { audience: ["user"], priority: 1.0 })],
      isError: true,
    });
  }
});

// --- List Resources ---
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  sendLog("debug", "mcp-server", { action: "list_resources" });
  return { resources: RESOURCES };
});

// --- List Resource Templates ---
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: RESOURCE_TEMPLATES };
});

// --- Read Resource ---
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  sendLog("debug", "mcp-server", { action: "read_resource", uri });
  
  try {
    // Static resources
    if (uri === "ha://states/summary") {
      const states = await callHA("/states");
      const summary = generateStateSummary(states);
      return {
        contents: [{ 
          uri, 
          mimeType: "text/markdown", 
          text: summary,
          annotations: { audience: ["user", "assistant"], priority: 0.9 },
        }],
      };
    }
    
    if (uri === "ha://automations") {
      const states = await callHA("/states");
      const automations = states
        .filter(s => s.entity_id.startsWith("automation."))
        .map(s => ({
          entity_id: s.entity_id,
          friendly_name: s.attributes?.friendly_name,
          state: s.state,
          last_triggered: s.attributes?.last_triggered,
        }));
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(automations, null, 2),
          annotations: { audience: ["assistant"], priority: 0.7 },
        }],
      };
    }
    
    if (uri === "ha://scripts") {
      const states = await callHA("/states");
      const scripts = states
        .filter(s => s.entity_id.startsWith("script."))
        .map(s => ({
          entity_id: s.entity_id,
          friendly_name: s.attributes?.friendly_name,
          state: s.state,
        }));
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(scripts, null, 2),
          annotations: { audience: ["assistant"], priority: 0.6 },
        }],
      };
    }
    
    if (uri === "ha://scenes") {
      const states = await callHA("/states");
      const scenes = states
        .filter(s => s.entity_id.startsWith("scene."))
        .map(s => ({
          entity_id: s.entity_id,
          friendly_name: s.attributes?.friendly_name,
        }));
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(scenes, null, 2),
          annotations: { audience: ["assistant"], priority: 0.6 },
        }],
      };
    }
    
    if (uri === "ha://areas") {
      // Use namespace to properly accumulate values in Jinja2 loop
      const result = await callHA("/template", "POST", {
        template: "{% set ns = namespace(areas=[]) %}{% for area in areas() %}{% set ns.areas = ns.areas + [{'id': area, 'name': area_name(area)}] %}{% endfor %}{{ ns.areas | tojson }}"
      });
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: result,
          annotations: { audience: ["assistant"], priority: 0.7 },
        }],
      };
    }
    
    if (uri === "ha://config") {
      const config = await callHA("/config");
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(config, null, 2),
          annotations: { audience: ["assistant"], priority: 0.5 },
        }],
      };
    }
    
    if (uri === "ha://integrations") {
      const config = await callHA("/config");
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(config.components || [], null, 2),
          annotations: { audience: ["assistant"], priority: 0.4 },
        }],
      };
    }
    
    if (uri === "ha://anomalies") {
      const states = await callHA("/states");
      const anomalies = states.map(detectAnomaly).filter(Boolean);
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(anomalies, null, 2),
          annotations: { audience: ["user", "assistant"], priority: 0.8 },
        }],
      };
    }
    
    if (uri === "ha://suggestions") {
      const states = await callHA("/states");
      const suggestions = generateSuggestions(states);
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(suggestions, null, 2),
          annotations: { audience: ["user", "assistant"], priority: 0.7 },
        }],
      };
    }
    
    // Template-based resources
    const statesMatch = uri.match(/^ha:\/\/states\/(\w+)$/);
    if (statesMatch) {
      const domain = statesMatch[1];
      const states = await callHA("/states");
      const filtered = states
        .filter(s => s.entity_id.startsWith(`${domain}.`))
        .map(s => ({
          entity_id: s.entity_id,
          state: s.state,
          friendly_name: s.attributes?.friendly_name,
          device_class: s.attributes?.device_class,
        }));
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(filtered, null, 2),
          annotations: { audience: ["assistant"], priority: 0.7 },
        }],
      };
    }
    
    const entityMatch = uri.match(/^ha:\/\/entity\/(.+)$/);
    if (entityMatch) {
      const entityId = entityMatch[1];
      const relationships = await getEntityRelationships(entityId);
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(relationships, null, 2),
          annotations: { audience: ["assistant"], priority: 0.8 },
        }],
      };
    }
    
    const areaMatch = uri.match(/^ha:\/\/area\/(.+)$/);
    if (areaMatch) {
      const areaId = areaMatch[1];
      const states = await callHA("/states");
      const areaEntities = states.filter(s => s.attributes?.area_id === areaId);
      const areaNameResult = await callHA("/template", "POST", {
        template: `{{ area_name('${areaId}') }}`
      });
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify({
            area_id: areaId,
            area_name: areaNameResult,
            entities: areaEntities.map(s => ({
              entity_id: s.entity_id,
              state: s.state,
              friendly_name: s.attributes?.friendly_name,
            })),
          }, null, 2),
          annotations: { audience: ["assistant"], priority: 0.7 },
        }],
      };
    }
    
    const historyMatch = uri.match(/^ha:\/\/history\/(.+)$/);
    if (historyMatch) {
      const entityId = historyMatch[1];
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({
        filter_entity_id: entityId,
        minimal_response: "true",
      });
      const history = await callHA(`/history/period/${encodeURIComponent(startTime)}?${params}`);
      return {
        contents: [{ 
          uri, 
          mimeType: "application/json", 
          text: JSON.stringify(history, null, 2),
          annotations: { audience: ["assistant"], priority: 0.6 },
        }],
      };
    }
    
    throw new Error(`Unknown resource: ${uri}`);
  } catch (error) {
    sendLog("error", "mcp-server", { action: "read_resource_error", uri, error: error.message });
    throw new Error(`Failed to read resource ${uri}: ${error.message}`);
  }
});

// --- List Prompts ---
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  sendLog("debug", "mcp-server", { action: "list_prompts" });
  return { prompts: PROMPTS };
});

// --- Get Prompt ---
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  sendLog("info", "mcp-server", { action: "get_prompt", prompt: name });
  
  try {
    switch (name) {
      case "troubleshoot_entity": {
        const entityId = args?.entity_id;
        if (!entityId) throw new Error("entity_id is required");
        const problemDesc = args?.problem_description || "not working as expected";
        
        return {
          description: `Troubleshooting guide for ${entityId}`,
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `I need help troubleshooting an entity in Home Assistant.

**Entity:** ${entityId}
**Problem:** ${problemDesc}

Please help me diagnose and fix this issue. Start by:
1. Using the \`diagnose_entity\` tool to get current state and history
2. Check if the entity is available and responding
3. Look at related entities that might be affected
4. Review the error log for any related messages
5. Suggest specific fixes based on what you find

Focus on practical solutions I can implement.`,
              annotations: { audience: ["assistant"], priority: 1.0 },
            },
          }],
        };
      }
      
      case "create_automation": {
        const goal = args?.goal;
        if (!goal) throw new Error("goal is required");
        
        return {
          description: "Automation creation guide",
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `I want to create a new Home Assistant automation.

**Goal:** ${goal}

Please help me create this automation by following these steps in order:
1. **Read the existing automations file** using \`read_file\` on \`automations.yaml\` (or wherever automations are stored). You MUST include ALL existing automations in the final write — never overwrite them.
2. Use \`search_entities\` to find relevant entities for this automation
3. Check if similar automations already exist using \`get_states\` with domain "automation"
4. Identify the best trigger(s) for this use case
5. Suggest any conditions that might be needed
6. Define the action(s) to take
7. Provide the complete YAML that contains ALL existing automations PLUS the new one

**CRITICAL:** When writing to \`automations.yaml\`, the content must include every automation that was already there. Writing only the new automation will permanently delete all others. \`write_config_safe\` will block the write if entries would be lost, but always verify yourself first.

Consider edge cases and make the automation robust.`,
              annotations: { audience: ["assistant"], priority: 1.0 },
            },
          }],
        };
      }
      
      case "energy_audit": {
        return {
          description: "Energy usage analysis and optimization",
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Please perform an energy audit of my Home Assistant setup.

Steps:
1. Use \`search_entities\` to find all energy/power related sensors
2. Check the current state of all lights using \`get_states\` with domain "light"
3. Review climate/thermostat entities
4. Look for smart plugs and their power consumption
5. Get suggestions using the \`get_suggestions\` tool

Provide a summary including:
- Current energy consumers that are active
- Potential energy savings opportunities
- Automation suggestions to reduce energy usage
- Any anomalies in power consumption`,
              annotations: { audience: ["assistant"], priority: 1.0 },
            },
          }],
        };
      }
      
      case "scene_builder": {
        const area = args?.area || "the specified area";
        const mood = args?.mood || "comfortable";
        
        return {
          description: "Interactive scene creation",
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Help me create a new scene for ${area} with a "${mood}" mood.

Steps:
1. Use \`get_areas\` to understand the available areas
2. Use \`search_entities\` to find controllable entities in the area (lights, switches, etc.)
3. For lights, suggest appropriate brightness and color temperature settings
4. For climate devices, suggest appropriate temperatures
5. Consider any media players or other relevant devices

Provide:
- A descriptive name for the scene
- Complete scene YAML configuration
- Any automations that might trigger this scene
- Tips for adjusting the scene`,
              annotations: { audience: ["assistant"], priority: 1.0 },
            },
          }],
        };
      }
      
      case "security_review": {
        return {
          description: "Security review of Home Assistant setup",
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Please perform a security review of my Home Assistant setup.

Steps:
1. Use \`search_entities\` to find all security-related entities:
   - Door/window sensors (binary_sensor with device_class door/window)
   - Motion sensors
   - Lock entities
   - Alarm panels
   - Camera entities

2. Check current states using \`get_states\`
3. Use \`detect_anomalies\` to find any issues
4. Review automation coverage for security scenarios

Provide:
- Current security status (all doors locked? sensors active?)
- Any vulnerabilities or gaps in coverage
- Suggested automations for better security
- Best practices recommendations`,
              annotations: { audience: ["assistant"], priority: 1.0 },
            },
          }],
        };
      }
      
      case "morning_routine": {
        const wakeTime = args?.wake_time || "7:00 AM";
        
        return {
          description: "Morning routine automation design",
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Help me design a morning routine automation for ${wakeTime}.

Steps:
1. Use \`search_entities\` to find relevant devices:
   - Bedroom lights
   - Coffee maker or kitchen appliances
   - Thermostat/climate
   - Window blinds/covers
   - Speakers for announcements

2. Check existing automations with \`get_states\` domain "automation"
3. Consider calendar integration using \`get_calendars\`

Design a routine that:
- Gradually increases lighting
- Adjusts temperature for waking
- Optionally starts coffee/breakfast prep
- Provides weather or calendar briefing

Provide complete automation YAML and any required helper entities.`,
              annotations: { audience: ["assistant"], priority: 1.0 },
            },
          }],
        };
      }
      
      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  } catch (error) {
    sendLog("error", "mcp-server", { action: "get_prompt_error", prompt: name, error: error.message });
    throw new Error(`Failed to get prompt ${name}: ${error.message}`);
  }
});

// ============================================================================
// START SERVER
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  sendLog("info", "mcp-server", { 
    action: "started",
    version: "2.6.0",
    tools: TOOLS.length,
    resources: RESOURCES.length,
    prompts: PROMPTS.length,
  });
  
  console.error("Home Assistant MCP server v2.6.0 started (Safe Config Edition)");
  console.error(`Capabilities: Tools (${TOOLS.length}), Resources (${RESOURCES.length}), Prompts (${PROMPTS.length}), Logging`);
  console.error("Features: Structured Output, Tool Annotations, Resource Links, Content Annotations, Live Docs, Safe Config Writing");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
