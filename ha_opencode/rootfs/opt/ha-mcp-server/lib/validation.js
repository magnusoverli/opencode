/**
 * Config Validation Helpers
 *
 * Pure functions for YAML structure validation and
 * safe path resolution within the HA config directory.
 */

import { isAbsolute, join, normalize } from "node:path/posix";

/** Default HA config directory (can be overridden for testing) */
const DEFAULT_CONFIG_DIR = "/homeassistant";

/**
 * Validate YAML content for structural issues in automations, scripts,
 * and template sensors. Returns an array of issue objects.
 */
export function validateYamlStructure(yamlContent) {
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
 *
 * @param {string} filePath - The path to resolve
 * @param {string} [configDir] - The config directory (defaults to /homeassistant)
 */
export function resolveConfigPath(filePath, configDir = DEFAULT_CONFIG_DIR) {
  // Reject absolute paths that point outside config dir
  if (isAbsolute(filePath) && !filePath.startsWith(configDir)) {
    return null;
  }

  // Resolve relative paths against the config directory
  const resolved = isAbsolute(filePath) ? filePath : join(configDir, filePath);
  const normalized = normalize(resolved);

  // Ensure the resolved path is still within the config directory
  if (!normalized.startsWith(configDir)) {
    return null;
  }

  // Block access to internal directories
  const relativePath = normalized.substring(configDir.length + 1);
  const blocked = [".storage", ".cloud", "deps", "tts", "__pycache__"];
  if (blocked.some(dir => relativePath.startsWith(dir + "/") || relativePath === dir)) {
    return null;
  }

  return normalized;
}
