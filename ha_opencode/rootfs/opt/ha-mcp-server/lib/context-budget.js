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
 * Fit a list of values into a byte budget, reporting what did not make it.
 *
 * "+N more" is measured before packing rather than appended afterwards, so the
 * count is never the thing that gets cut — a list that silently ends early reads
 * as a complete list.
 *
 * @param {string[]} items
 * @param {number} budgetBytes
 * @returns {{text: string, shown: number, omitted: number}}
 */
export function fitList(items, budgetBytes, options = {}) {
  const separator = options.separator ?? ", ";
  const values = (items ?? []).filter(Boolean).map(String);
  if (!values.length) return { text: "", shown: 0, omitted: 0 };

  const pack = (reserve) => {
    const shown = [];
    let used = 0;
    for (const value of values) {
      const cost = byteLength(value) + (shown.length ? byteLength(separator) : 0);
      if (used + cost > budgetBytes - reserve) break;
      shown.push(value);
      used += cost;
    }
    return shown;
  };

  const all = pack(0);
  if (all.length === values.length) {
    return { text: all.join(separator), shown: all.length, omitted: 0 };
  }

  // Reserve against the widest the suffix could be, so it always fits.
  const suffix = (omitted) => `${separator}+${omitted} more`;
  const shown = pack(byteLength(suffix(values.length)));
  const omitted = values.length - shown.length;
  if (!shown.length) return { text: "", shown: 0, omitted: values.length };

  return { text: `${shown.join(separator)}${suffix(omitted)}`, shown: shown.length, omitted };
}

/**
 * Assemble prioritized sections into a single document within a byte budget.
 *
 * Sections are emitted in priority order (lower number first). A section may
 * supply `render(availableBytes)` instead of fixed `text`, which lets a list
 * shrink to fit rather than disappearing whole — dropping every area name
 * because one more would not fit costs far more than showing twelve of eighteen.
 *
 * Space is reserved for the sections that follow, so an early greedy section
 * cannot starve the ones behind it, and anything still dropped is reported.
 *
 * @param {Array<{id: string, priority: number, text?: string, render?: (bytes: number) => string, min?: number, required?: boolean}>} sections
 * @param {number} budgetBytes
 */
export function assembleSections(sections, budgetBytes) {
  const ordered = [...sections]
    .map((section, index) => ({ ...section, index }))
    .filter((section) => section.render || String(section.text ?? "").trim().length > 0)
    .sort((a, b) => a.priority - b.priority || a.index - b.index);

  const separator = "\n\n";
  const separatorBytes = byteLength(separator);

  // What each section needs at minimum, used to hold space for later ones.
  const minBytes = ordered.map((section) =>
    typeof section.min === "number" ? section.min : byteLength(String(section.text ?? "").trim()),
  );
  const reserveAfter = new Array(ordered.length).fill(0);
  for (let i = ordered.length - 2; i >= 0; i -= 1) {
    reserveAfter[i] = reserveAfter[i + 1] + minBytes[i + 1] + separatorBytes;
  }

  const included = [];
  const dropped = [];
  let used = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const section = ordered[i];
    const separatorCost = included.length ? separatorBytes : 0;
    const room = budgetBytes - used - separatorCost - reserveAfter[i];

    const rendered = section.render ? section.render(Math.max(0, room)) : section.text;
    const text = String(rendered ?? "").trim();
    if (!text) {
      // Empty because there was nothing to say is not the same as empty because
      // it did not fit. Reporting "omitted for space" for a home that simply has
      // no areas inverts the very distinction this budgeting is meant to keep.
      if (!section.required && section.hasData !== false) dropped.push(section.id);
      continue;
    }

    const cost = byteLength(text) + separatorCost;
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

  const lines = String(secretsYamlText ?? "").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Block scalars (`cert: |`) hold certificates and private keys — the very
    // things that must never be echoed back — and a line scan that only reads
    // `key: value` would not see a single byte of them.
    const block = line.match(/^[^:#]+:\s*[|>][-+]?\d*\s*$/);
    if (block) {
      const body = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next];
        if (candidate.trim() && !/^\s/.test(candidate)) break; // dedented: block ended
        if (candidate.trim()) body.push(candidate.trim());
        index = next;
      }
      for (const value of body) {
        if (value.length >= minLength) values.add(value);
      }
      // The joined form matters too: a token wrapped across lines is one secret.
      const joined = body.join("\n");
      if (joined.length >= minLength) values.add(joined);
      continue;
    }

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
 * Narrow `secrets.yaml` values to the ones worth matching on the read path.
 *
 * Every value in that file is compared as a plain substring, and plenty of them
 * are not credentials: `mqtt_user: homeassistant`, a hostname, a directory name.
 * "homeassistant" appears in every path this add-on works with, so matching it
 * would withhold ordinary notes from the model — and a decision that silently
 * stops reaching the model is the failure this whole area exists to prevent.
 *
 * The write path stays stricter: there, a false positive is an error the model
 * can see and rephrase, so nothing is lost by over-blocking.
 */
export function plausibleSecretValues(values = []) {
  return (values ?? []).filter((value) => {
    const candidate = String(value ?? "");
    if (candidate.length < 12) return false;
    // Long enough to be a passphrase, or mixed enough to be a generated secret.
    return (
      candidate.length >= 16 ||
      /\d/.test(candidate) ||
      /[^A-Za-z0-9]/.test(candidate) ||
      (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate))
    );
  });
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
