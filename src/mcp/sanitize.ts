/**
 * Strip secret-like values from tool params before they are written to the
 * audit log. Two layers:
 *  1. Redact whole values whose KEY looks secret (token, secret, password, …).
 *  2. Redact GitLab token patterns found inside string VALUES, so a token a
 *     user pasted into a free-text field (e.g. an MR comment) is not persisted
 *     verbatim. Audit logs are a common exfiltration target.
 */
const SECRET_KEY_RE = /(token|secret|password|authorization|api[_-]?key|credential)/i;

// GitLab personal/OAuth/runner/etc. token prefixes, followed by their opaque body.
// Covers glpat-, gloas-, glptt-, glrt-, glcbt-, glimt-, glsoat-, gldt-, glagent-, feed tokens, etc.
const GITLAB_TOKEN_RE = /\bgl[a-z]*-[A-Za-z0-9_-]{8,}/g;

export function sanitizeParams(input: unknown): unknown {
  if (typeof input === "string") return redactValue(input);
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(sanitizeParams);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeParams(v);
    }
  }
  return out;
}

function redactValue(s: string): string {
  // If the whole value is a token, redact it entirely; otherwise scrub matches.
  if (/^gl[a-z]*-[A-Za-z0-9_-]{8,}$/.test(s.trim())) return "[REDACTED]";
  return s.replace(GITLAB_TOKEN_RE, "[REDACTED]");
}
