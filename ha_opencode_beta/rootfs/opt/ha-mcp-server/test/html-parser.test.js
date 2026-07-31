import { describe, it, expect } from "vitest";
import {
  extractContentFromHtml,
  extractConfigurationSection,
  extractYamlExamples,
} from "../lib/html-parser.js";

// ---------------------------------------------------------------------------
// extractContentFromHtml
// ---------------------------------------------------------------------------

describe("extractContentFromHtml", () => {
  it("extracts title from <title> tag", () => {
    const html = "<html><head><title>My Page</title></head><body>Hello</body></html>";
    const result = extractContentFromHtml(html);
    expect(result.title).toBe("My Page");
  });

  it("extracts meta description", () => {
    const html = `<html><head>
      <meta name="description" content="A great page">
    </head><body>content</body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.description).toBe("A great page");
  });

  it("extracts content from <article>", () => {
    const html = `<html><body>
      <nav>skip</nav>
      <article><p>Important content</p></article>
    </body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("Important content");
    expect(result.content).not.toContain("skip");
  });

  it("extracts content from <main> when no <article>", () => {
    const html = `<html><body><main><p>Main stuff</p></main></body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("Main stuff");
  });

  it("falls back to <body> content", () => {
    const html = `<html><body><p>Fallback</p></body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("Fallback");
  });

  it("strips script and style tags", () => {
    const html = `<html><body>
      <script>alert("bad")</script>
      <style>.x{color:red}</style>
      <p>Clean</p>
    </body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).not.toContain("alert");
    expect(result.content).not.toContain("color");
    expect(result.content).toContain("Clean");
  });

  it("converts headings to markdown", () => {
    const html = `<html><body>
      <article>
        <h1>Title</h1>
        <h2>Subtitle</h2>
        <h3>Section</h3>
      </article>
    </body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("# Title");
    expect(result.content).toContain("## Subtitle");
    expect(result.content).toContain("### Section");
  });

  it("converts code blocks", () => {
    const html = `<html><body><article>
      <pre><code>some code</code></pre>
    </article></body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("```");
    expect(result.content).toContain("some code");
  });

  it("converts inline code", () => {
    const html = `<html><body><article>
      Use <code>entity_id</code> here
    </article></body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("`entity_id`");
  });

  it("converts bold and italic", () => {
    const html = `<html><body><article>
      <strong>bold</strong> and <em>italic</em>
    </article></body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("**bold**");
    expect(result.content).toContain("*italic*");
  });

  it("decodes HTML entities", () => {
    const html = `<html><body><article>
      &amp; &lt; &gt; &quot; &#39; &nbsp;
    </article></body></html>`;
    const result = extractContentFromHtml(html);
    expect(result.content).toContain("&");
    expect(result.content).toContain("<");
    expect(result.content).toContain(">");
  });

  it("returns empty title when none found", () => {
    const html = "<html><body>No title</body></html>";
    expect(extractContentFromHtml(html).title).toBe("");
  });

  it("returns empty description when none found", () => {
    const html = "<html><body>No meta</body></html>";
    expect(extractContentFromHtml(html).description).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractConfigurationSection
// ---------------------------------------------------------------------------

describe("extractConfigurationSection", () => {
  it("extracts a ## Configuration section", () => {
    const content = `# Intro
Some text

## Configuration

Here is the config.

## Other Section

Not this.`;
    const result = extractConfigurationSection(content);
    expect(result).toContain("## Configuration");
    expect(result).toContain("Here is the config.");
    expect(result).not.toContain("Not this");
  });

  it("extracts a ## YAML Configuration section", () => {
    const content = `## YAML Configuration
key: value

## Next`;
    const result = extractConfigurationSection(content);
    expect(result).toContain("YAML Configuration");
  });

  it("extracts a ### Configuration Variables section", () => {
    const content = `### Configuration Variables
- host: required
- port: optional

### Other`;
    const result = extractConfigurationSection(content);
    expect(result).toContain("Configuration Variables");
    expect(result).toContain("host");
  });

  it("extracts a ## Setup section as fallback", () => {
    const content = `## Setup
Do the thing.

## Usage`;
    const result = extractConfigurationSection(content);
    expect(result).toContain("## Setup");
  });

  it("returns null if no config section found", () => {
    const content = `## Introduction
Just some info.`;
    expect(extractConfigurationSection(content)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractYamlExamples
// ---------------------------------------------------------------------------

describe("extractYamlExamples", () => {
  it("extracts fenced yaml blocks", () => {
    const content = `Some text

\`\`\`yaml
automation:
  trigger:
    platform: state
\`\`\`

More text

\`\`\`yaml
script:
  sequence: []
\`\`\``;
    const result = extractYamlExamples(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("automation:");
    expect(result[1]).toContain("script:");
  });

  it("extracts blocks with uppercase YAML fence", () => {
    const content = `\`\`\`YAML
key: value
\`\`\``;
    const result = extractYamlExamples(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("key: value");
  });

  it("extracts unfenced code blocks (no language specifier)", () => {
    const content = `\`\`\`
bare: block
\`\`\``;
    const result = extractYamlExamples(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("bare: block");
  });

  it("returns empty array when no fenced blocks exist", () => {
    expect(extractYamlExamples("No code here")).toEqual([]);
  });

  it("trims whitespace from extracted blocks", () => {
    const content = `\`\`\`yaml

  indented: yes

\`\`\``;
    const result = extractYamlExamples(content);
    expect(result[0]).toBe("indented: yes");
  });
});
