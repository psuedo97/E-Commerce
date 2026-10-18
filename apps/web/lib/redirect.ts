/**
 * Where to go after logging in. Only same-site paths are allowed: "//evil.com", "/\evil.com" and
 * full URLs would turn the login page into an open redirect.
 */
export function safeNext(next: string | undefined | null, fallback = '/'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
