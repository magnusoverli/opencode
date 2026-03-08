/**
 * YAML Context Analyzer — extracted from server.js for testability.
 *
 * Every method on this class is a pure function of its arguments
 * (document + position).  No side-effects, no server state.
 */

export class YamlContextAnalyzer {
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
    let currentIndent = lineBeforeCursor.match(/^(\s*)/)?.[1].length || 0;
    
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
        currentIndent = prevIndent;
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
