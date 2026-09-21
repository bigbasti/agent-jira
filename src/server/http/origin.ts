/**
 * The one rule for "did this request come from a page on this server?".
 *
 * Browsers attach `Origin` to every cross-site request that can carry a body, and to every
 * WebSocket upgrade, so it is what tells a forged submission from a real one. Same-origin
 * `fetch`es from this app's own pages either omit the header or send this host; non-browser
 * callers (which have no cookie to ride on anyway) send nothing.
 *
 * Compared against the request's own `Host` rather than the configured `publicUrl`, so it
 * still holds when a proxy or the vite dev server fronts the app.
 *
 * The literal string `null` — the opaque origin a sandboxed iframe sends — does not parse
 * as a URL and is therefore refused. That is deliberate: it is emphatically not this host,
 * and treating it as same-origin would be the one soft spot in a stack that is otherwise
 * parser scoping plus SameSite=Lax.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;

  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
