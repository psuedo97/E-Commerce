import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, discountPercent, formatINR, imageUrl } from './api';

describe('formatINR (paise -> rupees)', () => {
  it.each([
    [59900, '₹599'],
    [189900, '₹1,899'],
    [0, '₹0'],
    [50, '₹0.50'],
    [49950, '₹499.50'],
    [12345678, '₹1,23,456.78'], // Indian digit grouping (lakhs)
    [10000000, '₹1,00,000'],
  ])('%i paise -> %s', (paise, expected) => {
    expect(formatINR(paise)).toBe(expected);
  });
});

describe('discountPercent', () => {
  it('rounds to the nearest whole percent', () => {
    expect(discountPercent(79900, 59900)).toBe(25);
    expect(discountPercent(249900, 189900)).toBe(24);
    expect(discountPercent(300, 200)).toBe(33);
  });

  it('is 0 when price equals or exceeds mrp', () => {
    expect(discountPercent(1000, 1000)).toBe(0);
    expect(discountPercent(1000, 1200)).toBe(0);
  });
});

describe('imageUrl', () => {
  it('prefixes relative upload paths with the API origin', () => {
    expect(imageUrl('/uploads/products/p1/a.png')).toBe('http://localhost:4000/uploads/products/p1/a.png');
  });

  it('leaves absolute (S3/CDN) URLs untouched', () => {
    expect(imageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('returns null when there is no image', () => {
    expect(imageUrl(null)).toBeNull();
  });
});

describe('api()', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (impl: () => Promise<unknown>) => vi.stubGlobal('fetch', vi.fn(impl));

  it('returns parsed JSON on success and calls the versioned API', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ total: 3 }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api('/products')).resolves.toEqual({ total: 3 });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/api/v1/products', { cache: 'no-store' });
  });

  it('returns null on 404 so pages can call notFound()', async () => {
    stubFetch(async () => ({ status: 404, ok: false }));
    await expect(api('/products/nope')).resolves.toBeNull();
  });

  it('throws on other HTTP errors', async () => {
    stubFetch(async () => ({ status: 500, ok: false }));
    await expect(api('/products')).rejects.toThrow('API 500');
  });

  it('turns network failures into a readable error', async () => {
    stubFetch(async () => { throw new TypeError('fetch failed'); });
    await expect(api('/products')).rejects.toThrow('Cannot reach the API');
  });

  it('passes through unrelated errors (e.g. Next.js dynamic-render signals) unchanged', async () => {
    const signal = new Error('DYNAMIC_SERVER_USAGE');
    stubFetch(async () => { throw signal; });
    await expect(api('/products')).rejects.toBe(signal);
  });
});
