/**
 * Reads the `next` parameter the server attaches when it bounces an unauthenticated
 * request to the sign-in screen, and returns it only if it is a path back into this app.
 *
 * The server only ever writes its own request path there, but the value arrives through
 * the address bar, so it is treated as untrusted: anything that could leave this origin
 * — an absolute URL, a scheme-relative `//host`, the `/\host` form some parsers treat as
 * scheme-relative, or a `javascript:` payload — is refused rather than sanitised. The
 * result is assigned to `window.location`, and an open redirect on a sign-in screen is
 * exactly how a phishing page borrows a real domain.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeNextPath(search: string): string | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get('next');
  } catch {
    return null;
  }

  if (!value) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (CONTROL_CHARS.test(value)) return null;

  return value;
}
