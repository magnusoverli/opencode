#!/usr/bin/env node
/**
 * Home Assistant Language Server Protocol (LSP) Server
 * 
 * Provides intelligent editing features for Home Assistant YAML configuration files:
 * 
 * FEATURES:
 * - Entity ID autocomplete from live Home Assistant instance
 * - Service/action autocomplete with parameter hints
 * - Area, device, floor, and label completion
 * - Unknown entity/service diagnostics
 * - Hover information for entities (state, attributes)
 * - Jinja2 template preview on hover
 * - Go-to-definition for !include tags
 * - YAML validation for HA-specific configurations
 * 
 * REQUIREMENTS:
 * - SUPERVISOR_TOKEN environment variable (auto-provided in Home Assistant app)
 * - Home Assistant Supervisor API access
 * 
 * USAGE:
 * - Communicate via stdio (standard input/output)
 * - Configure in OpenCode via opencode.json lsp settings
 */

import lsp from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import yaml from "yaml";
import { fileURLToPath } from "url";
import { dirname, join, resolve, isAbsolute } from "path";
import { existsSync, readFileSync } from "fs";

// Destructure from CommonJS default export
const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  TextDocumentSyncKind,
  CompletionItemKind,
  MarkupKind,
  DiagnosticSeverity,
} = lsp;

const { parse: parseYaml } = yaml;

const __lsp_filename = fileURLToPath(import.meta.url);
const __lsp_dirname = dirname(__lsp_filename);

// ============================================================================
// SHARED DEPRECATION PATTERNS (with remote update support)
// ============================================================================

const GITHUB_PATTERNS_URL = "https://raw.githubusercontent.com/magnusoverli/ha_opencode/main/ha_opencode/rootfs/opt/shared/deprecation-patterns.json";

/**
 * Load deprecation patterns from the local shared JSON file.
 * These patterns are shared with the MCP server for consistency.
 */
function loadLocalDeprecationPatterns() {
  try {
    const patternsPath = resolve(__lsp_dirname, "../shared/deprecation-patterns.json");
    const raw = readFileSync(patternsPath, "utf-8");
    const patterns = JSON.parse(raw);
    return patterns.map(p => ({
      ...p,
      regex: new RegExp(p.pattern, p.flags || "m"),
    }));
  } catch (error) {
    console.error("Warning: Could not load local deprecation patterns:", error.message);
    return [];
  }
}

// Start with local patterns (always available synchronously)
let DEPRECATION_PATTERNS = loadLocalDeprecationPatterns();

/**
 * Attempt to fetch updated patterns from GitHub in the background.
 * If successful, replaces the local patterns. If not, keeps using local.
 * Runs once on startup with a delay to avoid blocking initialization.
 */
async function refreshDeprecationPatternsFromRemote() {
  try {
    const response = await fetch(GITHUB_PATTERNS_URL, {
      headers: { "User-Agent": "HA-LSP-Server/1.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    
    if (!response.ok) return;
    
    const patterns = await response.json();
    if (!Array.isArray(patterns) || patterns.length === 0) return;
    
    const compiled = patterns.map(p => ({
      ...p,
      regex: new RegExp(p.pattern, p.flags || "m"),
    }));
    
    // Only update if we got more or equal patterns (sanity check)
    if (compiled.length >= DEPRECATION_PATTERNS.length) {
      DEPRECATION_PATTERNS = compiled;
      console.error(`LSP: Updated deprecation patterns from remote (${compiled.length} patterns)`);
    }
  } catch (error) {
    // Silent fail — local patterns remain active
    console.error(`LSP: Remote pattern fetch skipped: ${error.message}`);
  }
}

// Refresh patterns 10 seconds after startup (non-blocking)
setTimeout(refreshDeprecationPatternsFromRemote, 10000);

// ============================================================================
// CONSTANTS
// ============================================================================

const SUPERVISOR_API = "http://supervisor/core/api";
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const CACHE_TTL = 60000; // 1 minute cache TTL

// HA configuration keys that expect entity IDs
const ENTITY_ID_KEYS = [
  "entity_id",
  "entity",
  "entities",
  "target",
  "device_id",
  "area_id",
  // Trigger-specific
  "platform",
  // Condition keys
  "condition",
  // Common automation/script keys
  "trigger",
  "action",
  "sequence",
];

// Keys that expect service names
const SERVICE_KEYS = [
  "service",
  "action",
];

// Keys that expect area references
const AREA_KEYS = [
  "area_id",
  "area",
];

// Keys that expect device references  
const DEVICE_KEYS = [
  "device_id",
  "device",
];

// Domain-specific attributes that take entity IDs
const ENTITY_ATTRIBUTE_PATTERNS = {
  "media_player": ["source"],
  "climate": ["target_temp_entity_id"],
  "light": ["rgb_color", "brightness"],
  "cover": ["position"],
};

// ============================================================================
// HOME ASSISTANT API CLIENT
// ============================================================================

class HomeAssistantClient {
  constructor() {
    this.cache = new Map();
    this.cacheTimestamps = new Map();
  }

  async fetch(endpoint, method = "GET", body = null) {
    if (!SUPERVISOR_TOKEN) {
      throw new Error("SUPERVISOR_TOKEN not available");
    }

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
      throw new Error(`HA API error (${response.status}): ${text}`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  isCacheValid(key) {
    const timestamp = this.cacheTimestamps.get(key);
    return timestamp && (Date.now() - timestamp) < CACHE_TTL;
  }

  async getCached(key, fetcher) {
    if (this.isCacheValid(key)) {
      return this.cache.get(key);
    }
    
    try {
      const data = await fetcher();
      this.cache.set(key, data);
      this.cacheTimestamps.set(key, Date.now());
      return data;
    } catch (error) {
      // Return stale cache if available on error
      if (this.cache.has(key)) {
        return this.cache.get(key);
      }
      throw error;
    }
  }

  invalidateCache() {
    this.cache.clear();
    this.cacheTimestamps.clear();
  }

  // ---- Cached API Methods ----

  async getStates() {
    return this.getCached("states", () => this.fetch("/states"));
  }

  async getServices() {
    return this.getCached("services", () => this.fetch("/services"));
  }

  async getConfig() {
    return this.getCached("config", () => this.fetch("/config"));
  }

  async getAreas() {
    return this.getCached("areas", async () => {
      const result = await this.fetch("/template", "POST", {
        template: `{% set area_list = [] %}{% for area in areas() %}{% set area_list = area_list + [{'id': area, 'name': area_name(area)}] %}{% endfor %}{{ area_list | tojson }}`
      });
      return JSON.parse(result);
    });
  }

  async getDevices() {
    return this.getCached("devices", async () => {
      const result = await this.fetch("/template", "POST", {
        template: `{% set device_list = [] %}{% for device in devices() %}{% set device_list = device_list + [{'id': device, 'name': device_attr(device, 'name'), 'area': device_attr(device, 'area_id')}] %}{% endfor %}{{ device_list | tojson }}`
      });
      return JSON.parse(result);
    });
  }

  async getFloors() {
    return this.getCached("floors", async () => {
      try {
        const result = await this.fetch("/template", "POST", {
          template: `{% set floor_list = [] %}{% for floor in floors() %}{% set floor_list = floor_list + [{'id': floor, 'name': floor_name(floor)}] %}{% endfor %}{{ floor_list | tojson }}`
        });
        return JSON.parse(result);
      } catch {
        // Floors might not be available in older HA versions
        return [];
      }
    });
  }

  async getLabels() {
    return this.getCached("labels", async () => {
      try {
        const result = await this.fetch("/template", "POST", {
          template: `{% set label_list = [] %}{% for label in labels() %}{% set label_list = label_list + [{'id': label, 'name': label_name(label)}] %}{% endfor %}{{ label_list | tojson }}`
        });
        return JSON.parse(result);
      } catch {
        // Labels might not be available in older HA versions
        return [];
      }
    });
  }

  async renderTemplate(template) {
    return this.fetch("/template", "POST", { template });
  }

  // ---- Derived Data ----

  async getEntityIds() {
    const states = await this.getStates();
    return states.map(s => s.entity_id);
  }

  async getEntityMap() {
    const states = await this.getStates();
    const map = new Map();
    for (const state of states) {
      map.set(state.entity_id, state);
    }
    return map;
  }

  async getDomains() {
    const states = await this.getStates();
    const domains = new Set();
    for (const state of states) {
      const [domain] = state.entity_id.split(".");
      domains.add(domain);
    }
    return Array.from(domains).sort();
  }

  async getServiceList() {
    const services = await this.getServices();
    const list = [];
    for (const domainObj of services) {
      const domain = domainObj.domain;
      for (const [serviceName, serviceInfo] of Object.entries(domainObj.services)) {
        list.push({
          domain,
          service: serviceName,
          fullName: `${domain}.${serviceName}`,
          name: serviceInfo.name || serviceName,
          description: serviceInfo.description || "",
          fields: serviceInfo.fields || {},
          target: serviceInfo.target,
        });
      }
    }
    return list;
  }
}

// ============================================================================
// YAML CONTEXT ANALYZER
// ============================================================================

class YamlContextAnalyzer {
  /**
   * Analyze the YAML context at a given position
   */
  analyzeContext(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const lines = text.split("\n");
    const line = lines[position.line] || "";
    const lineBeforeCursor = line.substring(0, position.character);
    
    // Determine what kind of value is expected
    const context = {
      line,
      lineBeforeCursor,
      offset,
      position,
      inKey: false,
      inValue: false,
      key: null,
      parentKey: null,
      parentKeys: [],
      inList: false,
      inJinja: false,
      triggerType: null,
      actionType: null,
      domain: null,
    };

    // Check if we're inside Jinja template
    const jinjaStart = lineBeforeCursor.lastIndexOf("{{");
    const jinjaEnd = lineBeforeCursor.lastIndexOf("}}");
    if (jinjaStart > jinjaEnd) {
      context.inJinja = true;
    }

    // Determine if we're in a key or value position
    const colonIndex = lineBeforeCursor.indexOf(":");
    if (colonIndex === -1) {
      context.inKey = true;
    } else {
      context.inValue = true;
      context.key = lineBeforeCursor.substring(0, colonIndex).trim().replace(/^-\s*/, "");
    }

    // Check if we're in a list item
    if (lineBeforeCursor.match(/^\s*-\s*/)) {
      context.inList = true;
    }

    // Find parent keys by analyzing indentation
    const currentIndent = lineBeforeCursor.match(/^(\s*)/)?.[1].length || 0;
    
    for (let i = position.line - 1; i >= 0; i--) {
      const prevLine = lines[i];
      const prevIndent = prevLine.match(/^(\s*)/)?.[1].length || 0;
      const keyMatch = prevLine.match(/^(\s*)([a-z_]+)\s*:/i);
      
      if (keyMatch && prevIndent < currentIndent) {
        const key = keyMatch[2];
        context.parentKeys.unshift(key);
        if (!context.parentKey) {
          context.parentKey = key;
        }
        currentIndent === prevIndent;
      }
    }

    // Detect specific context types
    if (context.parentKeys.includes("trigger") || context.parentKeys.includes("triggers")) {
      // Find trigger platform
      for (let i = position.line; i >= 0; i--) {
        const platformMatch = lines[i].match(/platform:\s*(\w+)/);
        if (platformMatch) {
          context.triggerType = platformMatch[1];
          break;
        }
      }
    }

    if (context.parentKeys.includes("action") || context.parentKeys.includes("actions")) {
      // We're in an action block
      for (let i = position.line; i >= 0; i--) {
        const serviceMatch = lines[i].match(/service:\s*([\w.]+)/);
        if (serviceMatch) {
          const [domain] = serviceMatch[1].split(".");
          context.domain = domain;
          break;
        }
      }
    }

    return context;
  }

  /**
   * Get all entity ID references in the document for diagnostics
   */
  findEntityReferences(document) {
    const text = document.getText();
    const references = [];
    
    // Match entity_id: value patterns
    const entityIdPattern = /entity_id:\s*([a-z_]+\.[a-z0-9_]+)/gi;
    let match;
    
    while ((match = entityIdPattern.exec(text)) !== null) {
      const startOffset = match.index + match[0].indexOf(match[1]);
      const endOffset = startOffset + match[1].length;
      references.push({
        entityId: match[1],
        range: {
          start: document.positionAt(startOffset),
          end: document.positionAt(endOffset),
        },
      });
    }

    // Match entity_id in lists
    const listEntityPattern = /entity_id:\s*\n(\s+-\s+[a-z_]+\.[a-z0-9_]+\s*)+/gi;
    while ((match = listEntityPattern.exec(text)) !== null) {
      const listContent = match[0];
      const itemPattern = /-\s+([a-z_]+\.[a-z0-9_]+)/gi;
      let itemMatch;
      while ((itemMatch = itemPattern.exec(listContent)) !== null) {
        const absoluteOffset = match.index + itemMatch.index + itemMatch[0].indexOf(itemMatch[1]);
        references.push({
          entityId: itemMatch[1],
          range: {
            start: document.positionAt(absoluteOffset),
            end: document.positionAt(absoluteOffset + itemMatch[1].length),
          },
        });
      }
    }

    // Match states() Jinja calls
    const statesPattern = /states\(['"]([a-z_]+\.[a-z0-9_]+)['"]\)/gi;
    while ((match = statesPattern.exec(text)) !== null) {
      const startOffset = match.index + match[0].indexOf(match[1]);
      references.push({
        entityId: match[1],
        range: {
          start: document.positionAt(startOffset),
          end: document.positionAt(startOffset + match[1].length),
        },
        inJinja: true,
      });
    }

    // Match is_state() Jinja calls
    const isStatePattern = /is_state\(['"]([a-z_]+\.[a-z0-9_]+)['"]/gi;
    while ((match = isStatePattern.exec(text)) !== null) {
      const startOffset = match.index + match[0].indexOf(match[1]);
      references.push({
        entityId: match[1],
        range: {
          start: document.positionAt(startOffset),
          end: document.positionAt(startOffset + match[1].length),
        },
        inJinja: true,
      });
    }

    return references;
  }

  /**
   * Find service references in document
   */
  findServiceReferences(document) {
    const text = document.getText();
    const references = [];
    
    // Match service: domain.action patterns
    const servicePattern = /(?:service|action):\s*([a-z_]+\.[a-z0-9_]+)/gi;
    let match;
    
    while ((match = servicePattern.exec(text)) !== null) {
      const startOffset = match.index + match[0].indexOf(match[1]);
      references.push({
        service: match[1],
        range: {
          start: document.positionAt(startOffset),
          end: document.positionAt(startOffset + match[1].length),
        },
      });
    }

    return references;
  }

  /**
   * Find !include references
   */
  findIncludeReferences(document) {
    const text = document.getText();
    const references = [];
    
    const includePattern = /!include\s+([^\s\n]+)/g;
    let match;
    
    while ((match = includePattern.exec(text)) !== null) {
      const filePath = match[1];
      const startOffset = match.index + match[0].indexOf(filePath);
      references.push({
        path: filePath,
        range: {
          start: document.positionAt(startOffset),
          end: document.positionAt(startOffset + filePath.length),
        },
      });
    }

    return references;
  }
}

// ============================================================================
// LSP SERVER
// ============================================================================

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager
const documents = new TextDocuments(TextDocument);

// Create instances
const haClient = new HomeAssistantClient();
const yamlAnalyzer = new YamlContextAnalyzer();

// Track initialization state
let hasWorkspaceFolderCapability = false;
let workspaceFolders = [];

// ============================================================================
// INITIALIZATION
// ============================================================================

connection.onInitialize((params) => {
  const capabilities = params.capabilities;
  
  hasWorkspaceFolderCapability = !!(
    capabilities.workspace && capabilities.workspace.workspaceFolders
  );
  
  if (params.workspaceFolders) {
    workspaceFolders = params.workspaceFolders;
  }

  const result = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: [".", ":", " ", '"', "'", "/"],
      },
      hoverProvider: true,
      definitionProvider: true,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    },
  };

  if (hasWorkspaceFolderCapability) {
    result.capabilities.workspace = {
      workspaceFolders: {
        supported: true,
        changeNotifications: true,
      },
    };
  }

  return result;
});

connection.onInitialized(() => {
  if (hasWorkspaceFolderCapability) {
    connection.workspace.onDidChangeWorkspaceFolders((event) => {
      connection.console.log("Workspace folder change event received.");
    });
  }
  
  // Pre-warm the cache
  warmCache();
});

async function warmCache() {
  if (!SUPERVISOR_TOKEN) {
    connection.console.log("No SUPERVISOR_TOKEN - HA features disabled");
    return;
  }
  
  try {
    await Promise.all([
      haClient.getStates(),
      haClient.getServices(),
      haClient.getAreas(),
      haClient.getDevices(),
    ]);
    connection.console.log("HA cache warmed successfully");
  } catch (error) {
    connection.console.error(`Failed to warm cache: ${error.message}`);
  }
}

// ============================================================================
// COMPLETION PROVIDER
// ============================================================================

connection.onCompletion(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];

  const context = yamlAnalyzer.analyzeContext(document, params.position);
  const completions = [];

  try {
    // Inside Jinja template
    if (context.inJinja) {
      return await getJinjaCompletions(context);
    }

    // Completing a value
    if (context.inValue) {
      const key = context.key?.toLowerCase();

      // Entity ID completion
      if (key === "entity_id" || key === "entity" || key === "entities") {
        return await getEntityCompletions(context);
      }

      // Service completion
      if (key === "service" || key === "action") {
        return await getServiceCompletions(context);
      }

      // Area completion
      if (key === "area_id" || key === "area") {
        return await getAreaCompletions(context);
      }

      // Device completion
      if (key === "device_id" || key === "device") {
        return await getDeviceCompletions(context);
      }

      // Platform completion for triggers
      if (key === "platform" && context.parentKeys.includes("trigger")) {
        return getTriggerPlatformCompletions();
      }

      // Condition type completion
      if (key === "condition") {
        return getConditionTypeCompletions();
      }
    }

    // Completing a key
    if (context.inKey) {
      return getKeyCompletions(context);
    }

  } catch (error) {
    connection.console.error(`Completion error: ${error.message}`);
  }

  return completions;
});

async function getEntityCompletions(context) {
  const completions = [];
  
  try {
    const states = await haClient.getStates();
    
    // Parse partial input to filter
    const partialMatch = context.lineBeforeCursor.match(/:\s*([a-z_.]*)$/i);
    const partial = partialMatch?.[1]?.toLowerCase() || "";
    
    for (const state of states) {
      const entityId = state.entity_id;
      const friendlyName = state.attributes?.friendly_name || entityId;
      const [domain] = entityId.split(".");
      
      // Filter by partial match
      if (partial && !entityId.toLowerCase().includes(partial) && 
          !friendlyName.toLowerCase().includes(partial)) {
        continue;
      }

      completions.push({
        label: entityId,
        kind: CompletionItemKind.Value,
        detail: friendlyName,
        documentation: {
          kind: MarkupKind.Markdown,
          value: [
            `**${friendlyName}**`,
            "",
            `- **State:** ${state.state}`,
            `- **Domain:** ${domain}`,
            state.attributes?.device_class ? `- **Device Class:** ${state.attributes.device_class}` : "",
            state.attributes?.unit_of_measurement ? `- **Unit:** ${state.attributes.unit_of_measurement}` : "",
          ].filter(Boolean).join("\n"),
        },
        insertText: entityId,
        sortText: entityId.startsWith(partial) ? `0${entityId}` : `1${entityId}`,
        data: { type: "entity", entityId },
      });
    }
  } catch (error) {
    connection.console.error(`Entity completion error: ${error.message}`);
  }

  return completions;
}

async function getServiceCompletions(context) {
  const completions = [];
  
  try {
    const services = await haClient.getServiceList();
    
    // Parse partial input
    const partialMatch = context.lineBeforeCursor.match(/:\s*([a-z_.]*)$/i);
    const partial = partialMatch?.[1]?.toLowerCase() || "";
    
    for (const service of services) {
      if (partial && !service.fullName.toLowerCase().includes(partial)) {
        continue;
      }

      const fieldDocs = Object.entries(service.fields)
        .slice(0, 5)
        .map(([name, field]) => `- \`${name}\`: ${field.description || "No description"}`)
        .join("\n");

      completions.push({
        label: service.fullName,
        kind: CompletionItemKind.Function,
        detail: service.name || service.service,
        documentation: {
          kind: MarkupKind.Markdown,
          value: [
            `**${service.fullName}**`,
            "",
            service.description,
            "",
            fieldDocs ? "**Fields:**" : "",
            fieldDocs,
          ].filter(Boolean).join("\n"),
        },
        insertText: service.fullName,
        sortText: service.fullName.startsWith(partial) ? `0${service.fullName}` : `1${service.fullName}`,
        data: { type: "service", service: service.fullName },
      });
    }
  } catch (error) {
    connection.console.error(`Service completion error: ${error.message}`);
  }

  return completions;
}

async function getAreaCompletions(context) {
  const completions = [];
  
  try {
    const areas = await haClient.getAreas();
    
    for (const area of areas) {
      completions.push({
        label: area.id,
        kind: CompletionItemKind.Folder,
        detail: area.name,
        documentation: `Area: ${area.name}`,
        insertText: area.id,
        data: { type: "area", areaId: area.id },
      });
    }
  } catch (error) {
    connection.console.error(`Area completion error: ${error.message}`);
  }

  return completions;
}

async function getDeviceCompletions(context) {
  const completions = [];
  
  try {
    const devices = await haClient.getDevices();
    
    for (const device of devices) {
      if (!device.id) continue;
      
      completions.push({
        label: device.id,
        kind: CompletionItemKind.Module,
        detail: device.name || device.id,
        documentation: device.area ? `Device in area: ${device.area}` : "Device",
        insertText: device.id,
        data: { type: "device", deviceId: device.id },
      });
    }
  } catch (error) {
    connection.console.error(`Device completion error: ${error.message}`);
  }

  return completions;
}

async function getJinjaCompletions(context) {
  const completions = [];
  const lineBeforeCursor = context.lineBeforeCursor;
  
  // Check for states() completion
  if (lineBeforeCursor.match(/states\s*\(\s*['"]?[a-z_.]*$/i)) {
    try {
      const states = await haClient.getStates();
      for (const state of states) {
        completions.push({
          label: state.entity_id,
          kind: CompletionItemKind.Value,
          detail: state.attributes?.friendly_name || state.entity_id,
          insertText: `${state.entity_id}'`,
          data: { type: "jinja_entity", entityId: state.entity_id },
        });
      }
    } catch (error) {
      connection.console.error(`Jinja entity completion error: ${error.message}`);
    }
    return completions;
  }

  // Jinja function completions
  const jinjaFunctions = [
    { label: "states", detail: "Get entity state", insertText: "states('$1')" },
    { label: "is_state", detail: "Check entity state", insertText: "is_state('$1', '$2')" },
    { label: "state_attr", detail: "Get entity attribute", insertText: "state_attr('$1', '$2')" },
    { label: "is_state_attr", detail: "Check entity attribute", insertText: "is_state_attr('$1', '$2', '$3')" },
    { label: "now", detail: "Current datetime", insertText: "now()" },
    { label: "today_at", detail: "Time today", insertText: "today_at('$1')" },
    { label: "as_timestamp", detail: "Convert to timestamp", insertText: "as_timestamp($1)" },
    { label: "relative_time", detail: "Human-readable time diff", insertText: "relative_time($1)" },
    { label: "float", detail: "Convert to float", insertText: "float($1)" },
    { label: "int", detail: "Convert to int", insertText: "int($1)" },
    { label: "area_entities", detail: "Get area entities", insertText: "area_entities('$1')" },
    { label: "area_devices", detail: "Get area devices", insertText: "area_devices('$1')" },
    { label: "device_entities", detail: "Get device entities", insertText: "device_entities('$1')" },
    { label: "device_attr", detail: "Get device attribute", insertText: "device_attr('$1', '$2')" },
  ];

  for (const fn of jinjaFunctions) {
    completions.push({
      label: fn.label,
      kind: CompletionItemKind.Function,
      detail: fn.detail,
      insertText: fn.insertText,
      insertTextFormat: 2, // Snippet
    });
  }

  return completions;
}

function getTriggerPlatformCompletions() {
  const platforms = [
    { label: "state", detail: "Trigger on entity state change" },
    { label: "numeric_state", detail: "Trigger on numeric threshold" },
    { label: "time", detail: "Trigger at specific time" },
    { label: "time_pattern", detail: "Trigger on time pattern" },
    { label: "sun", detail: "Trigger at sunrise/sunset" },
    { label: "zone", detail: "Trigger on zone enter/leave" },
    { label: "device", detail: "Device trigger" },
    { label: "mqtt", detail: "MQTT message trigger" },
    { label: "webhook", detail: "Webhook trigger" },
    { label: "event", detail: "Event trigger" },
    { label: "homeassistant", detail: "HA start/stop trigger" },
    { label: "template", detail: "Template trigger" },
    { label: "calendar", detail: "Calendar event trigger" },
    { label: "geo_location", detail: "Geo location trigger" },
    { label: "conversation", detail: "Voice assistant trigger" },
    { label: "persistent_notification", detail: "Notification trigger" },
  ];

  return platforms.map(p => ({
    label: p.label,
    kind: CompletionItemKind.EnumMember,
    detail: p.detail,
    insertText: p.label,
  }));
}

function getConditionTypeCompletions() {
  const conditions = [
    { label: "state", detail: "Entity state condition" },
    { label: "numeric_state", detail: "Numeric state condition" },
    { label: "time", detail: "Time window condition" },
    { label: "sun", detail: "Sun position condition" },
    { label: "zone", detail: "Zone condition" },
    { label: "template", detail: "Template condition" },
    { label: "device", detail: "Device condition" },
    { label: "and", detail: "All conditions must be true" },
    { label: "or", detail: "Any condition must be true" },
    { label: "not", detail: "Condition must be false" },
    { label: "trigger", detail: "Check which trigger fired" },
  ];

  return conditions.map(c => ({
    label: c.label,
    kind: CompletionItemKind.EnumMember,
    detail: c.detail,
    insertText: c.label,
  }));
}

function getKeyCompletions(context) {
  const completions = [];
  
  // Automation keys
  if (context.parentKeys.length === 0 || context.parentKeys[0] === "automation") {
    const automationKeys = [
      { label: "alias", detail: "Friendly name for the automation" },
      { label: "description", detail: "Description of the automation" },
      { label: "trigger", detail: "Trigger conditions" },
      { label: "condition", detail: "Conditions to check" },
      { label: "action", detail: "Actions to perform" },
      { label: "mode", detail: "Execution mode (single, restart, queued, parallel)" },
      { label: "max", detail: "Max concurrent runs (for queued/parallel)" },
      { label: "max_exceeded", detail: "Action when max exceeded" },
      { label: "variables", detail: "Variables available in automation" },
      { label: "trace", detail: "Trace configuration" },
    ];
    
    for (const key of automationKeys) {
      completions.push({
        label: key.label,
        kind: CompletionItemKind.Property,
        detail: key.detail,
        insertText: `${key.label}: `,
      });
    }
  }

  // Trigger keys
  if (context.parentKey === "trigger" || context.parentKeys.includes("trigger")) {
    const triggerKeys = [
      { label: "platform", detail: "Trigger platform type" },
      { label: "entity_id", detail: "Entity to monitor" },
      { label: "to", detail: "State to transition to" },
      { label: "from", detail: "State to transition from" },
      { label: "for", detail: "Duration in state" },
      { label: "attribute", detail: "Attribute to monitor" },
      { label: "id", detail: "Trigger identifier" },
      { label: "variables", detail: "Trigger-local variables" },
    ];
    
    for (const key of triggerKeys) {
      completions.push({
        label: key.label,
        kind: CompletionItemKind.Property,
        detail: key.detail,
        insertText: `${key.label}: `,
      });
    }
  }

  // Action keys
  if (context.parentKey === "action" || context.parentKeys.includes("action")) {
    const actionKeys = [
      { label: "service", detail: "Service to call" },
      { label: "action", detail: "Action to call (alias for service)" },
      { label: "target", detail: "Target entities/areas/devices" },
      { label: "data", detail: "Service data" },
      { label: "entity_id", detail: "Entity ID (in target)" },
      { label: "delay", detail: "Delay before next action" },
      { label: "wait_template", detail: "Wait for template to be true" },
      { label: "wait_for_trigger", detail: "Wait for trigger" },
      { label: "repeat", detail: "Repeat actions" },
      { label: "choose", detail: "Conditional actions" },
      { label: "if", detail: "If-then-else" },
      { label: "parallel", detail: "Run actions in parallel" },
      { label: "sequence", detail: "Sequence of actions" },
      { label: "variables", detail: "Set variables" },
      { label: "stop", detail: "Stop execution" },
      { label: "event", detail: "Fire event" },
    ];
    
    for (const key of actionKeys) {
      completions.push({
        label: key.label,
        kind: CompletionItemKind.Property,
        detail: key.detail,
        insertText: `${key.label}: `,
      });
    }
  }

  return completions;
}

connection.onCompletionResolve(async (item) => {
  // Resolve additional details for completion items
  if (item.data?.type === "entity") {
    try {
      const states = await haClient.getStates();
      const state = states.find(s => s.entity_id === item.data.entityId);
      if (state) {
        const attrs = Object.entries(state.attributes || {})
          .filter(([k]) => !k.startsWith("_"))
          .slice(0, 10)
          .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
          .join("\n");
        
        item.documentation = {
          kind: MarkupKind.Markdown,
          value: [
            `**${state.attributes?.friendly_name || state.entity_id}**`,
            "",
            `**Current State:** ${state.state}`,
            "",
            "**Attributes:**",
            attrs,
          ].join("\n"),
        };
      }
    } catch (error) {
      // Ignore resolution errors
    }
  }
  
  return item;
});

// ============================================================================
// HOVER PROVIDER
// ============================================================================

connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const position = params.position;
  const text = document.getText();
  const offset = document.offsetAt(position);
  
  // Get the word at cursor position
  const wordRange = getWordRangeAtPosition(document, position);
  if (!wordRange) return null;
  
  const word = document.getText(wordRange);

  // Check if it looks like an entity ID
  if (word.match(/^[a-z_]+\.[a-z0-9_]+$/i)) {
    return await getEntityHover(word);
  }

  // Check if it's a service
  if (word.match(/^[a-z_]+\.[a-z0-9_]+$/i)) {
    // Check context to see if this is a service
    const lineText = text.split("\n")[position.line];
    if (lineText.match(/(?:service|action):\s*/)) {
      return await getServiceHover(word);
    }
  }

  // Check for Jinja template - try to render it
  const jinjaMatch = text.substring(0, offset).match(/\{\{[^}]*$/);
  if (jinjaMatch) {
    const templateEnd = text.indexOf("}}", offset);
    if (templateEnd !== -1) {
      const template = text.substring(
        text.lastIndexOf("{{", offset),
        templateEnd + 2
      );
      return await getTemplateHover(template);
    }
  }

  return null;
});

async function getEntityHover(entityId) {
  try {
    const entityMap = await haClient.getEntityMap();
    const state = entityMap.get(entityId);
    
    if (!state) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Unknown entity:** \`${entityId}\`\n\nThis entity does not exist in Home Assistant.`,
        },
      };
    }

    const friendlyName = state.attributes?.friendly_name || entityId;
    const [domain] = entityId.split(".");
    
    const attrs = Object.entries(state.attributes || {})
      .filter(([k]) => !k.startsWith("_") && k !== "friendly_name")
      .slice(0, 10)
      .map(([k, v]) => {
        const value = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `| ${k} | ${value.substring(0, 50)}${value.length > 50 ? "..." : ""} |`;
      })
      .join("\n");

    const markdown = [
      `## ${friendlyName}`,
      "",
      `\`${entityId}\``,
      "",
      `**State:** \`${state.state}\``,
      "",
      `**Domain:** ${domain}`,
      state.attributes?.device_class ? `**Device Class:** ${state.attributes.device_class}` : "",
      state.attributes?.unit_of_measurement ? `**Unit:** ${state.attributes.unit_of_measurement}` : "",
      "",
      "### Attributes",
      "| Attribute | Value |",
      "|-----------|-------|",
      attrs,
      "",
      `*Last changed: ${state.last_changed}*`,
    ].filter(Boolean).join("\n");

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: markdown,
      },
    };
  } catch (error) {
    return null;
  }
}

async function getServiceHover(serviceName) {
  try {
    const services = await haClient.getServiceList();
    const service = services.find(s => s.fullName === serviceName);
    
    if (!service) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**Unknown service:** \`${serviceName}\``,
        },
      };
    }

    const fieldDocs = Object.entries(service.fields)
      .map(([name, field]) => {
        const required = field.required ? " *(required)*" : "";
        return `- **${name}**${required}: ${field.description || "No description"}`;
      })
      .join("\n");

    const markdown = [
      `## ${service.fullName}`,
      "",
      service.description,
      "",
      service.target ? "**Supports targeting** entities, areas, or devices" : "",
      "",
      fieldDocs ? "### Fields" : "",
      fieldDocs,
    ].filter(Boolean).join("\n");

    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: markdown,
      },
    };
  } catch (error) {
    return null;
  }
}

async function getTemplateHover(template) {
  try {
    const result = await haClient.renderTemplate(template);
    
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: [
          "### Template Result",
          "",
          "```",
          String(result),
          "```",
        ].join("\n"),
      },
    };
  } catch (error) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: [
          "### Template Error",
          "",
          "```",
          error.message,
          "```",
        ].join("\n"),
      },
    };
  }
}

function getWordRangeAtPosition(document, position) {
  const text = document.getText();
  const offset = document.offsetAt(position);
  
  // Find word boundaries (include . for entity IDs and services)
  let start = offset;
  let end = offset;
  
  while (start > 0 && /[a-zA-Z0-9_.]/.test(text[start - 1])) {
    start--;
  }
  
  while (end < text.length && /[a-zA-Z0-9_.]/.test(text[end])) {
    end++;
  }
  
  if (start === end) return null;
  
  return {
    start: document.positionAt(start),
    end: document.positionAt(end),
  };
}

// ============================================================================
// DIAGNOSTICS PROVIDER
// ============================================================================

async function validateDocument(document) {
  const diagnostics = [];
  
  if (!SUPERVISOR_TOKEN) {
    // Can't validate without HA connection
    return diagnostics;
  }

  try {
    // Validate entity references
    const entityRefs = yamlAnalyzer.findEntityReferences(document);
    const entityMap = await haClient.getEntityMap();
    
    for (const ref of entityRefs) {
      if (!entityMap.has(ref.entityId)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: ref.range,
          message: `Unknown entity: ${ref.entityId}`,
          source: "ha-lsp",
          code: "unknown-entity",
        });
      }
    }

    // Validate service references
    const serviceRefs = yamlAnalyzer.findServiceReferences(document);
    const services = await haClient.getServiceList();
    const serviceSet = new Set(services.map(s => s.fullName));
    
    for (const ref of serviceRefs) {
      if (!serviceSet.has(ref.service)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Warning,
          range: ref.range,
          message: `Unknown service: ${ref.service}`,
          source: "ha-lsp",
          code: "unknown-service",
        });
      }
    }

    // Validate !include paths
    const includeRefs = yamlAnalyzer.findIncludeReferences(document);
    const docPath = fileURLToPath(document.uri);
    const docDir = dirname(docPath);
    
    for (const ref of includeRefs) {
      const includePath = isAbsolute(ref.path) 
        ? ref.path 
        : resolve(docDir, ref.path);
      
      if (!existsSync(includePath)) {
        diagnostics.push({
          severity: DiagnosticSeverity.Error,
          range: ref.range,
          message: `Include file not found: ${ref.path}`,
          source: "ha-lsp",
          code: "include-not-found",
        });
      }
    }

    // Check for deprecated syntax patterns
    const text = document.getText();
    for (const dp of DEPRECATION_PATTERNS) {
      // Only flag warning/error severity patterns, skip info-level
      if (dp.severity === "info") continue;
      
      const match = dp.regex.exec(text);
      if (match) {
        const startOffset = match.index;
        // Highlight just the matched line, not the entire multi-line match
        const matchedLine = match[0].split("\n")[0];
        const endOffset = startOffset + matchedLine.length;
        
        const severity = dp.deprecated_in
          ? DiagnosticSeverity.Warning
          : DiagnosticSeverity.Information;
        
        const message = dp.deprecated_in
          ? `[Deprecated since ${dp.deprecated_in}] ${dp.message}`
          : dp.message;
        
        diagnostics.push({
          severity,
          range: {
            start: document.positionAt(startOffset),
            end: document.positionAt(endOffset),
          },
          message,
          source: "ha-lsp",
          code: `deprecated-${dp.id}`,
        });
      }
    }

    // Basic YAML validation
    try {
      parseYaml(document.getText());
    } catch (yamlError) {
      // Extract position from YAML error if available
      const errorPos = yamlError.linePos?.[0];
      const range = errorPos ? {
        start: { line: errorPos.line - 1, character: errorPos.col - 1 },
        end: { line: errorPos.line - 1, character: errorPos.col },
      } : {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      };
      
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range,
        message: `YAML syntax error: ${yamlError.message}`,
        source: "ha-lsp",
        code: "yaml-syntax",
      });
    }

  } catch (error) {
    connection.console.error(`Validation error: ${error.message}`);
  }

  return diagnostics;
}

// Document change handler - validate on change
documents.onDidChangeContent(async (change) => {
  const document = change.document;
  
  // Only validate YAML files
  if (!document.uri.endsWith(".yaml") && !document.uri.endsWith(".yml")) {
    return;
  }
  
  // Debounce validation
  clearTimeout(validationTimeout);
  validationTimeout = setTimeout(async () => {
    const diagnostics = await validateDocument(document);
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
  }, 500);
});

let validationTimeout;

// ============================================================================
// GO-TO-DEFINITION PROVIDER
// ============================================================================

connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const position = params.position;
  const text = document.getText();
  const lineText = text.split("\n")[position.line];
  
  // Check for !include
  const includeMatch = lineText.match(/!include\s+([^\s\n]+)/);
  if (includeMatch) {
    const includePath = includeMatch[1];
    const docPath = fileURLToPath(document.uri);
    const docDir = dirname(docPath);
    
    const resolvedPath = isAbsolute(includePath) 
      ? includePath 
      : resolve(docDir, includePath);
    
    if (existsSync(resolvedPath)) {
      return {
        uri: `file://${resolvedPath}`,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      };
    }
  }

  // Check for !secret
  const secretMatch = lineText.match(/!secret\s+(\w+)/);
  if (secretMatch) {
    const secretName = secretMatch[1];
    const docPath = fileURLToPath(document.uri);
    const docDir = dirname(docPath);
    
    // Look for secrets.yaml in the same directory or parent
    const possiblePaths = [
      resolve(docDir, "secrets.yaml"),
      resolve(docDir, "..", "secrets.yaml"),
      "/homeassistant/secrets.yaml",
    ];
    
    for (const secretsPath of possiblePaths) {
      if (existsSync(secretsPath)) {
        // TODO: Parse secrets.yaml to find the exact line
        return {
          uri: `file://${secretsPath}`,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        };
      }
    }
  }

  return null;
});

// ============================================================================
// DOCUMENT MANAGEMENT
// ============================================================================

documents.onDidClose((e) => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// Listen for document events
documents.listen(connection);

// Start listening
connection.listen();

// Log startup
connection.console.log("Home Assistant LSP Server started");
if (SUPERVISOR_TOKEN) {
  connection.console.log("SUPERVISOR_TOKEN available - HA features enabled");
} else {
  connection.console.log("SUPERVISOR_TOKEN not available - running in limited mode");
}
