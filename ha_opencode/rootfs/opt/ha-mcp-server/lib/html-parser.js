/**
 * HTML / Documentation Parsing Helpers
 *
 * Pure functions for extracting content from HTML documentation,
 * finding configuration sections, and extracting YAML examples.
 */

/**
 * Extract title, description, and main content from an HTML string.
 * Strips tags and converts common HTML to rough Markdown.
 */
export function extractContentFromHtml(html) {
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
 * Extract the "Configuration" section from a Markdown/text document.
 * Returns the matched section text, or null if not found.
 */
export function extractConfigurationSection(content) {
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
 * Extract fenced YAML code blocks from Markdown/text content.
 * Returns an array of YAML strings (without the fence markers).
 */
export function extractYamlExamples(content) {
  const examples = [];
  const codeBlockRegex = /```(?:yaml|YAML)?\n([\s\S]*?)```/g;

  let match;
  while ((match = codeBlockRegex.exec(content)) !== null) {
    examples.push(match[1].trim());
  }

  return examples;
}
