export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

/** Returns `base`, or `base-2`, `base-3`... until `exists` says the slug is free. */
export async function uniqueSlug(base: string, exists: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  let slug = root;
  for (let n = 2; await exists(slug); n++) slug = `${root}-${n}`;
  return slug;
}
