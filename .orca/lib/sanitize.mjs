// Lightweight secret & PII redaction helper for logs, status, issue errors, CI diffs, and ledger.
// Strips URL basic-auth credentials, query tokens, JSON-quoted secret fields (including escaped quotes
// and truncated unclosed tails), key-value secrets, Bearer/Basic/token headers, JWTs, API keys,
// PEM private keys, and email addresses, and truncates untrusted raw output snippets AFTER redaction.
// Zero external dependencies (Node >= 18).

const SECRET_KEY_NAMES = "api[_-]?key|apikey|tokenhub[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|client[_-]?secret|webhook[_-]?secret|private[_-]?key|secret|password|passwd|pwd|token|gh[_-]?token|gitea[_-]?token|github[_-]?token|cookie|set-cookie|authorization";

const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const URL_BASIC_AUTH_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const URL_SENSITIVE_QUERY_RE = /([?&](?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|pwd|auth|key|signature|sig)=)([^&#\s"']+)/gi;
const AUTH_HEADER_RE = /\b((?:Authorization\s*[:=]\s*["']?)?(?:Bearer|Basic|token))\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const KNOWN_TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g;

// JSON / YAML / JS quoted key-value pairs supporting escaped quotes (`\"` / `\'`) and spaces inside values!
const JSON_DQ_KV_SECRET_RE = new RegExp(`(["'])(${SECRET_KEY_NAMES})\\1(\\s*:\\s*)"(?:\\\\.|[^"\\\\\\r\\n])*"`, "gi");
const JSON_SQ_KV_SECRET_RE = new RegExp(`(["'])(${SECRET_KEY_NAMES})\\1(\\s*:\\s*)'(?:\\\\.|[^'\\\\\\r\\n])*'`, "gi");
// Unclosed / truncated quoted secret value at end-of-line or end-of-input: omit remainder conservatively!
const JSON_UNCLOSED_KV_SECRET_RE = new RegExp(`(["'])(${SECRET_KEY_NAMES})\\1(\\s*:\\s*)(["'])(?:\\\\.|(?!\\4)[^\\r\\n])*$`, "gim");

// Unquoted key with quoted value (supporting escaped quotes) or unquoted token value, plus unclosed quoted tail:
const KV_QUOTED_SECRET_RE = new RegExp(`\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3)[^\\\\\\r\\n])*\\3`, "gi");
const KV_UNCLOSED_QUOTED_SECRET_RE = new RegExp(`\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3)[^\\r\\n])*$`, "gim");
const KV_BARE_SECRET_RE = new RegExp(`\\b(${SECRET_KEY_NAMES})(\\s*[:=]\\s*)(?!\\[REDACTED)([^\\s"',;}{\\r\\n]+)`, "gi");

// Match standard email addresses while avoiding SCP-style git remotes like git@github.com:org/repo
const EMAIL_RE = /\b(?!git@[A-Za-z0-9.-]+:)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?![:/])/g;

const SENSITIVE_OBJECT_KEY_RE = /(?:password|passwd|pwd|secret|token|apikey|api_key|privatekey|private_key|authorization|cookie|credential)/i;

export function sanitizeText(input, { maxLen = 0 } = {}) {
  if (input == null) return input;
  let text = String(input);
  if (!text) return text;

  text = text.replace(PEM_BLOCK_RE, "[REDACTED_PRIVATE_KEY]");
  text = text.replace(URL_BASIC_AUTH_RE, "$1[REDACTED]:[REDACTED]@");
  text = text.replace(URL_SENSITIVE_QUERY_RE, "$1[REDACTED]");
  text = text.replace(JSON_DQ_KV_SECRET_RE, (_, qk, key, sep) => `${qk}${key}${qk}${sep}"[REDACTED]"`);
  text = text.replace(JSON_SQ_KV_SECRET_RE, (_, qk, key, sep) => `${qk}${key}${qk}${sep}'[REDACTED]'`);
  text = text.replace(JSON_UNCLOSED_KV_SECRET_RE, (_, qk, key, sep, qv) => `${qk}${key}${qk}${sep}${qv}[REDACTED]${qv}`);
  text = text.replace(AUTH_HEADER_RE, (_, prefix) => `${prefix} [REDACTED]`);
  text = text.replace(JWT_RE, "[REDACTED_JWT]");
  text = text.replace(KNOWN_TOKEN_PREFIX_RE, "[REDACTED_TOKEN]");
  text = text.replace(KV_QUOTED_SECRET_RE, (_, key, sep, q) => `${key}${sep}${q}[REDACTED]${q}`);
  text = text.replace(KV_UNCLOSED_QUOTED_SECRET_RE, (_, key, sep, q) => `${key}${sep}${q}[REDACTED]${q}`);
  text = text.replace(KV_BARE_SECRET_RE, (_, key, sep) => `${key}${sep}[REDACTED]`);
  text = text.replace(EMAIL_RE, "[REDACTED_EMAIL]");

  if (maxLen > 0 && text.length > maxLen) {
    text = `${text.slice(0, maxLen)}...[truncated]`;
  }
  return text;
}

export function sanitizeValue(value, { maxStringLen = 400, depth = 0 } = {}) {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeText(value, { maxLen: maxStringLen });
  if (typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, { maxStringLen, depth: depth + 1 }));
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_OBJECT_KEY_RE.test(k) && v != null && typeof v !== "object") {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeValue(v, { maxStringLen, depth: depth + 1 });
    }
  }
  return out;
}
