import { describe, expect, it } from 'vitest';
import { safeNext } from './redirect';

describe('safeNext', () => {
  it.each(['/', '/cart', '/checkout', '/orders/abc123', '/products?category=men&page=2'])('allows the same-site path %s', (p) => {
    expect(safeNext(p)).toBe(p);
  });

  it.each([
    'https://evil.com', 'http://evil.com/login', '//evil.com', '//evil.com/path', '/\\evil.com', 'javascript:alert(1)',
    'evil.com', 'cart', '', undefined, null,
  ])('falls back for %s', (p) => {
    expect(safeNext(p as string | null | undefined)).toBe('/');
  });

  it('uses a custom fallback', () => {
    expect(safeNext('//evil.com', '/orders')).toBe('/orders');
  });
});
