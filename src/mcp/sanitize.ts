/**
 * Strip secret-like values from tool params before they are written to the
 * audit log. Conservative: redacts by key name and obvious token patterns.
 */
const SECRET_KEY_RE = /(token|secret|password|authorization|api[_-]?key|credential)/i;

export function sanitizeParams(input: unknown): unknown {
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
