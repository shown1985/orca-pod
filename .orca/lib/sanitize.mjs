// Lightweight secret & PII redaction helper for logs, status, issue errors, and ledger.
// Strips URL basic-auth credentials, query tokens, Bearer/API keys, PEM private keys,
// and email addresses, and truncates untrusted raw output snippets.
// Zero external dependencies (Node >= 18).

const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const URL_BASIC_AUTH_RE = /\b(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const URL_SENSITIVE_QUERY_RE = /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|auth|key|signature|sig)=)([^&#\s"']+)/gi;
const AUTH_HEADER_RE = /\b((?:Authorization\s*[:=]\s*)?(?:Bearer|Basic|token))\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KNOWN_TOKEN_PREFIX_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const KV_SECRET_RE = /\b(api[_-]?key|tokenhub[_-]?api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd|gh[_-]?token|gitea[_-]?token|github[_-]?token)(\s*[:=]\s*)(["']?)([^\s"',;}{]+)\3/gi;
// Match standard email addresses while avoiding SCP-style git remotes like git@github.com:org/repo
const EMAIL_RE = /\b(?!git@[A-Za-z0-9.-]+:)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b(?![:/])/g;

export function sanitizeText(input, { maxLen = 0 } = {}) {
  if (input == null) return input;
  let text = String(input);
  if (!text) return text;

  text = text.replace(PEM_BLOCK_RE, "[REDACTED_PRIVATE_KEY]");
  text = text.replace(URL_BASIC_AUTH_RE, "$1[REDACTED]:[REDACTED]@");
  text = text.replace(URL_SENSITIVE_QUERY_RE, "$1[REDACTED]");
  text = text.replace(AUTH_HEADER_RE, (_, prefix) => `${prefix} [REDACTED]`);
  text = text.replace(KNOWN_TOKEN_PREFIX_RE, "[REDACTED_TOKEN]");
  text = text.replace(KV_SECRET_RE, (_, key, sep, quote) => `${key}${sep}${quote}[REDACTED]${quote}`);
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
    if (/^(?:password|passwd|secret|token|apiKey|api_key|privateKey|private_key|authorization)$/i.test(k) && v != null) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeValue(v, { maxStringLen, depth: depth + 1 });
    }
  }
  return out;
}
