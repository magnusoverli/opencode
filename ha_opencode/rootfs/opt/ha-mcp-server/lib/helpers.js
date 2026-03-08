/**
 * MCP Content Helpers
 *
 * Pure utility functions for building MCP content objects.
 */

/**
 * Build an MCP text content object with optional annotations.
 */
export function createTextContent(text, options = {}) {
  const content = { type: "text", text };
  if (options.audience || options.priority !== undefined) {
    content.annotations = {};
    if (options.audience) content.annotations.audience = options.audience;
    if (options.priority !== undefined) content.annotations.priority = options.priority;
  }
  return content;
}

/**
 * Build an MCP resource link object with optional annotations.
 */
export function createResourceLink(uri, name, description, options = {}) {
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
