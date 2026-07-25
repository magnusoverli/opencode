/**
 * Budgeting and secret-safety helpers for add-on generated context.
 *
 * Everything the add-on injects into OpenCode's `instructions` array lands in
 * the system prompt, which is re-sent with every request and is not removed by
 * compaction. Generated context therefore has to be budgeted by construction
 * rather than trimmed after the fact, and it must never carry credentials to a
 * model provider.
 *
 * Pure functions only — no filesystem or network access, so the rules stay
 * testable without a running Home Assistant.
 */

/** Byte length of a string as it will be written to disk (UTF-8). */
export function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/**
 * Trim text to a byte budget on a line boundary.
 *
 * Cutting mid-line produces context that reads as corrupt to a model, so the
 * last partial line is dropped entirely and replaced with a marker.
 */
export function clampToBytes(text, maxBytes, options = {}) {
  const value = String(text ?? "");
  if (maxBytes <= 0) return { text: "", truncated: true, bytes: 0 };
  if (byteLength(value) <= maxBytes) {
    return { text: value, truncated: false, bytes: byteLength(value) };
  }

  const marker = options.marker ?? "\n_(truncated to fit the context budget)_";
  const markerBytes = byteLength(marker);
  const available = Math.max(0, maxBytes - markerBytes);

  const lines = value.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    // +1 for the newline that rejoins this line to the previous one
    const cost = byteLength(line) + (kept.length ? 1 : 0);
    if (used + cost > available) break;
    kept.push(line);
    used += cost;
  }

  const body = kept.join("\n");
  const out = body ? `${body}${marker}` : marker.trimStart();
  return { text: out, truncated: true, bytes: byteLength(out) };
}

/**
 * Assemble prioritized sections into a single document within a byte budget.
 *
 * Sections are emitted in priority order (lower number first). A section that
 * does not fit is skipped rather than truncated, and lower-priority sections
 * are still considered — a small trailing section should not be lost because
 * one large section ahead of it overflowed.
 *
 * @param {Array<{id: string, priority: number, text: string, required?: boolean}>} sections
 * @param {number} budgetBytes
 */
export function assembleSections(sections, budgetBytes) {
  const ordered = [...sections]
    .map((section, index) => ({ ...section, index }))
    .filter((section) => String(section.text ?? "").trim().length > 0)
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  const separator = "\n\n";
  const included = [];
  const dropped = [];
  let used = 0;

  for (const section of ordered) {
    const text = String(section.text).trim();
    const cost = byteLength(text) + (included.length ? byteLength(separator) : 0);
    if (!section.required && used + cost > budgetBytes) {
      dropped.push(section.id);
      continue;
    }
    included.push({ ...section, text });
    used += cost;
  }

  const document = included.map((section) => section.text).join(separator);
  // A required section can still push past the budget; clamp as a backstop so
  // the budget is a guarantee rather than an intention.
  const clamped = clampToBytes(document, budgetBytes);

  return {
    text: clamped.text,
    bytes: clamped.bytes,
    truncated: clamped.truncated,
    includedSections: included.map((section) => section.id),
    droppedSections: dropped,
  };
}

/**
 * Values that look like credentials regardless of surrounding context.
 *
 * Kept deliberately narrow: a false positive blocks a legitimate note and
 * teaches users to work around the check, which is worse than a near miss.
 */
const SECRET_PATTERNS = [
  { kind: "json_web_token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "private_key_block", pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { kind: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i },
  { kind: "authorization_header", pattern: /\bauthorization\s*[:=]\s*\S{16,}/i },
  {
    kind: "inline_credential",
    // `password: hunter2` / `api_key=abcd1234...` — the label plus a value that
    // is long enough to be a real credential rather than a placeholder.
    pattern: /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
  },
  { kind: "url_with_credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{4,}@/i },
  {
    kind: "prose_credential",
    // "the broker password is hunter2hunter2" — a credential noun followed by
    // something that actually looks like a value. The `validate` step is what
    // keeps "the password is stored in secrets.yaml" from being flagged.
    pattern:
      /\b(?:password|passphrase|api[ _-]?key|access[ _-]?token|client[ _-]?secret|secret[ _-]?key)\b(?:\s+\w+){0,3}?\s+(?:is|was|=|:)\s+["']?([^\s"'.,;]{8,})/i,
    validate: (match) => looksLikeCredentialValue(match[1]),
  },
];

/**
 * Whether a captured value is plausibly a credential rather than prose.
 *
 * Over-blocking is the failure mode that matters here: a note refused for
 * saying "the password is unchanged" teaches users to work around the check.
 */
function looksLikeCredentialValue(value) {
  const candidate = String(value ?? "");
  if (candidate.length < 8) return false;
  if (candidate.startsWith("!")) return false; // `!secret foo` is a reference
  // Ordinary words that follow a credential noun in normal writing.
  if (/^(?:unchanged|configured|different|identical|required|optional|rotated|generated|disabled|whatever)$/i.test(candidate)) {
    return false;
  }
  const mixed = /[A-Za-z]/.test(candidate) && /\d/.test(candidate);
  const encoded = /^[A-Fa-f0-9]{16,}$/.test(candidate) || /^[A-Za-z0-9+/]{20,}={0,2}$/.test(candidate);
  return mixed || encoded || candidate.length >= 20;
}

/**
 * Extract candidate secret values from a Home Assistant `secrets.yaml`.
 *
 * Line-scanned rather than YAML-parsed: `secrets.yaml` is a flat mapping by
 * definition, and a scanner that cannot throw is worth more here than one that
 * understands anchors. Values are used only for comparison and are never
 * returned to a caller or written anywhere.
 *
 * @returns {string[]} distinct values long enough to be worth matching
 */
export function extractSecretValues(secretsYamlText, options = {}) {
  const minLength = options.minLength ?? 6;
  const values = new Set();

  for (const rawLine of String(secretsYamlText ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^[^:#]+:\s*(.+)$/);
    if (!match) continue;

    let value = match[1].trim();
    // A quoted value is taken verbatim (a `#` inside a password is part of the
    // password); only an unquoted value can carry a trailing comment.
    const quoted = /^(["'])(.*)\1\s*(?:#.*)?$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      value = value.split(" #")[0].trim();
    }

    if (value.length >= minLength) values.add(value);
  }

  return [...values];
}

/**
 * Report credential-shaped content without ever echoing the match.
 *
 * @param {string} text
 * @param {string[]} knownSecretValues values from `secrets.yaml`
 * @returns {Array<{kind: string}>}
 */
export function findSecrets(text, knownSecretValues = []) {
  const value = String(text ?? "");
  const findings = [];

  for (const { kind, pattern, validate } of SECRET_PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    if (validate && !validate(match)) continue;
    findings.push({ kind });
  }

  for (const secret of knownSecretValues) {
    if (secret && value.includes(secret)) {
      findings.push({ kind: "secrets_yaml_value" });
      break;
    }
  }

  return findings;
}

/** Human-readable, non-revealing explanation for a `findSecrets` result. */
export function describeSecretFindings(findings) {
  const labels = {
    json_web_token: "what looks like a long-lived access token",
    private_key_block: "a private key block",
    bearer_token: "a bearer token",
    authorization_header: "an authorization header value",
    inline_credential: "an inline password or API key",
    url_with_credentials: "a URL containing embedded credentials",
    prose_credential: "what looks like a password or key written out in full",
    secrets_yaml_value: "a value that also appears in secrets.yaml",
  };
  const seen = [...new Set(findings.map((finding) => finding.kind))];
  return seen.map((kind) => labels[kind] ?? kind).join(", ");
}
