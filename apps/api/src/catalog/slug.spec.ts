import { slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('Classic Cotton T-Shirt')).toBe('classic-cotton-t-shirt');
  });

  it('collapses punctuation and trims dashes from the ends', () => {
    expect(slugify('  --Hello,   World!!  ')).toBe('hello-world');
  });

  it('removes accents', () => {
    expect(slugify('Café Kurta')).toBe('cafe-kurta');
  });

  it('falls back to "item" when nothing usable is left', () => {
    expect(slugify('!!!')).toBe('item');
    expect(slugify('कुर्ता')).toBe('item'); // non-Latin only
  });

  it('caps the length at 80 characters', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(80);
  });
});

describe('uniqueSlug', () => {
  const taken = (...slugs: string[]) => async (s: string) => slugs.includes(s);

  it('returns the plain slug when it is free', async () => {
    expect(await uniqueSlug('Test Hoodie', taken())).toBe('test-hoodie');
  });

  it('appends -2, -3 ... until a free slug is found', async () => {
    expect(await uniqueSlug('Test Hoodie', taken('test-hoodie'))).toBe('test-hoodie-2');
    expect(await uniqueSlug('Test Hoodie', taken('test-hoodie', 'test-hoodie-2'))).toBe('test-hoodie-3');
  });
});
