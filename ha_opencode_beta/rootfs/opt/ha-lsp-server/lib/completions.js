/**
 * Completion helpers — extracted from server.js for testability.
 *
 * Each function is pure: it returns an array of LSP CompletionItem-like
 * objects.  The caller (server.js) supplies CompletionItemKind so this
 * module does not depend on the vscode-languageserver runtime.
 */

/**
 * @param {object} CompletionItemKind — the LSP enum (EnumMember, Property, …)
 */
export function getTriggerPlatformCompletions(CompletionItemKind) {
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

/**
 * @param {object} CompletionItemKind — the LSP enum
 */
export function getConditionTypeCompletions(CompletionItemKind) {
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

/**
 * @param {object} context — the result of YamlContextAnalyzer.analyzeContext()
 * @param {object} CompletionItemKind — the LSP enum
 */
export function getKeyCompletions(context, CompletionItemKind) {
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

/**
 * Get the word range at a position in a text document.
 * Includes dots so entity IDs like "light.living_room" are treated as one word.
 *
 * @param {object} document — LSP TextDocument (getText, offsetAt, positionAt)
 * @param {object} position — { line, character }
 * @returns {{ start, end } | null}
 */
export function getWordRangeAtPosition(document, position) {
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
