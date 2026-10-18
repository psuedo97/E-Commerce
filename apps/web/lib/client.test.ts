import { describe, expect, it, vi } from 'vitest';
import { ApiError, createClient, messageOf } from './client';

const BASE = 'http://api.test/api/v1';
const USER = { id: 'u1', name: 'Asha', email: 'asha@example.com', phone: null, role: 'CUSTOMER' as const };
const EMPTY_CART = { id: null, items: [], itemCount: 0, subtotal: 0, hasIssues: false };

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/** A fake fetch driven by a handler, recording every call. */
function setup(handler: Handler) {
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  const fakeFetch = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    calls.push({ path: url.replace(BASE, ''), method: init.method ?? 'GET', headers, body: init.body ? JSON.parse(init.body as string) : undefined });
    const { status = 200, body = null } = await handler(url, init);
    return new Response(body === null ? null : JSON.stringify(body), { status });
  });
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  const client = createClient({ fetch: fakeFetch as unknown as typeof fetch, storage, baseUrl: BASE });
  return { client, calls, data, fakeFetch };
}

describe('messageOf', () => {
  it('uses a string message as is', () => expect(messageOf({ message: 'Out of stock' })).toBe('Out of stock'));
  it('joins validation message lists', () => expect(messageOf({ message: ['a is bad', 'b is bad'] })).toBe('a is bad, b is bad'));
  it('falls back to a friendly default', () => {
    expect(messageOf(null)).toMatch(/Something went wrong/);
    expect(messageOf({})).toMatch(/Something went wrong/);
    expect(messageOf({ message: 42 })).toMatch(/Something went wrong/);
  });
});

describe('requests', () => {
  it('calls the versioned API with cookies enabled and parses JSON', async () => {
    const { client, fakeFetch } = setup(() => ({ body: { ok: true } }));
    await expect(client.get('/products')).resolves.toEqual({ ok: true });
    expect(fakeFetch).toHaveBeenCalledWith(`${BASE}/products`, expect.objectContaining({ credentials: 'include' }));
  });

  it('sends JSON bodies with a content type', async () => {
    const { client, calls } = setup(() => ({ body: {} }));
    await client.post('/thing', { a: 1 });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { a: 1 } });
    expect(calls[0].headers.get('Content-Type')).toBe('application/json');
  });

  it('turns error responses into ApiError with the server message and status', async () => {
    const { client } = setup(() => ({ status: 409, body: { message: 'Only 3 available', available: 3 } }));
    const err = await client.post('/cart/items', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'Only 3 available', body: { available: 3 } });
  });

  it('copes with an empty response body (204)', async () => {
    const { client } = setup(() => ({ status: 204 }));
    await expect(client.del('/x')).resolves.toBeNull();
  });

  it('lets network failures propagate', async () => {
    const { client, fakeFetch } = setup(() => ({}));
    fakeFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client.get('/x')).rejects.toThrow('fetch failed');
  });
});

describe('login session', () => {
  it('starts logged out, then sends the access token on every request after login', async () => {
    const { client, calls } = setup((url) => url.endsWith('/auth/login') ? { body: { accessToken: 'tok1', user: USER } } : { body: {} });
    expect(client.isLoggedIn()).toBe(false);
    await client.login('asha@example.com', 'password123');
    expect(client.isLoggedIn()).toBe(true);
    expect(client.getUser()).toEqual(USER);
    await client.get('/orders');
    expect(calls.at(-1)!.headers.get('Authorization')).toBe('Bearer tok1');
    expect(calls[0].headers.get('Authorization')).toBeNull(); // the login call itself is anonymous
  });

  it('notifies subscribers on login and logout, and stops after unsubscribe', async () => {
    const { client } = setup((url) => url.endsWith('/auth/login') ? { body: { accessToken: 't', user: USER } } : { status: 204 });
    const listener = vi.fn();
    const off = client.subscribe(listener);
    await client.login('a@b.co', 'password123');
    expect(listener).toHaveBeenCalledTimes(1);
    await client.logout();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    await client.login('a@b.co', 'password123');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('logs out locally even if the server call fails', async () => {
    let loggedIn = false;
    const { client } = setup((url) => {
      if (url.endsWith('/auth/login')) { loggedIn = true; return { body: { accessToken: 't', user: USER } }; }
      return { status: 500, body: { message: 'boom' } };
    });
    await client.login('a@b.co', 'password123');
    expect(loggedIn).toBe(true);
    await client.logout();
    expect(client.isLoggedIn()).toBe(false);
    expect(client.getUser()).toBeNull();
  });

  it('registers (omitting an empty phone) and signs the new user in', async () => {
    const { client, calls } = setup(() => ({ body: { accessToken: 't', user: USER } }));
    await client.register('Asha', 'asha@example.com', 'password123', '');
    expect(calls[0].body).toEqual({ name: 'Asha', email: 'asha@example.com', password: 'password123' });
    expect(client.isLoggedIn()).toBe(true);
  });

  it('shows the server message on a bad login', async () => {
    const { client } = setup(() => ({ status: 401, body: { message: 'Invalid email or password' } }));
    await expect(client.login('a@b.co', 'wrongpass1')).rejects.toThrow('Invalid email or password');
    expect(client.isLoggedIn()).toBe(false);
  });
});

describe('restoring a session after a page reload', () => {
  it('logs in from the refresh cookie when it is valid', async () => {
    const { client } = setup(() => ({ body: { accessToken: 'fresh', user: USER } }));
    await expect(client.restore()).resolves.toBe(true);
    expect(client.getUser()).toEqual(USER);
  });

  it('stays logged out when there is no valid cookie', async () => {
    const { client } = setup(() => ({ status: 401, body: { message: 'Unauthorized' } }));
    await expect(client.restore()).resolves.toBe(false);
    expect(client.isLoggedIn()).toBe(false);
  });

  it('stays logged out, without throwing, when the network is down', async () => {
    const { client, fakeFetch } = setup(() => ({}));
    fakeFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(client.restore()).resolves.toBe(false);
  });
});

describe('expired access tokens', () => {
  /** Server whose first access token ("old") has expired: only the token from a refresh ("new") works. */
  const expiredTokenServer = () =>
    setup((url, init) => {
      if (url.endsWith('/auth/login')) return { body: { accessToken: 'old', user: USER } };
      if (url.endsWith('/auth/refresh')) return { body: { accessToken: 'new', user: USER } };
      return new Headers(init.headers).get('Authorization') === 'Bearer new' ? { body: { ok: 1 } } : { status: 401 };
    });

  it('does not refresh while the token is still valid', async () => {
    const s = setup((url) => url.endsWith('/auth/login') ? { body: { accessToken: 'old', user: USER } } : { body: { ok: 1 } });
    await s.client.login('a@b.co', 'password123');
    await s.client.get('/orders');
    expect(s.calls.map((c) => c.path)).toEqual(['/auth/login', '/orders']);
  });

  it('on 401 gets a new token, retries with it, and the caller never notices', async () => {
    const s = expiredTokenServer();
    await s.client.login('a@b.co', 'password123');
    await expect(s.client.get('/orders')).resolves.toEqual({ ok: 1 });
    expect(s.calls.map((c) => c.path)).toEqual(['/auth/login', '/orders', '/auth/refresh', '/orders']);
    expect(s.calls.at(-1)!.headers.get('Authorization')).toBe('Bearer new');
  });

  it('logs out and reports 401 when the refresh also fails, without looping', async () => {
    const s = setup((url) =>
      url.endsWith('/auth/login') ? { body: { accessToken: 'old', user: USER } } : { status: 401, body: { message: 'Unauthorized' } });
    await s.client.login('a@b.co', 'password123');

    const failure = (await s.client.get('/orders').catch((e) => e)) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(401);
    expect(s.client.isLoggedIn()).toBe(false);
    expect(s.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1); // tried once, gave up
    expect(s.calls.filter((c) => c.path === '/orders')).toHaveLength(1); // not retried after a failed refresh
  });

  it('does not retry more than once if the new token is also rejected', async () => {
    const s = setup((url) => {
      if (url.endsWith('/auth/login')) return { body: { accessToken: 'a', user: USER } };
      if (url.endsWith('/auth/refresh')) return { body: { accessToken: 'b', user: USER } };
      return { status: 401, body: { message: 'Unauthorized' } };
    });
    await s.client.login('a@b.co', 'password123');
    await expect(s.client.get('/orders')).rejects.toMatchObject({ status: 401 });
    expect(s.calls.filter((c) => c.path === '/orders')).toHaveLength(2);
    expect(s.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });

  it('shares one refresh between simultaneous expired requests', async () => {
    const s = setup((url, init) => {
      if (url.endsWith('/auth/login')) return { body: { accessToken: 'old', user: USER } };
      if (url.endsWith('/auth/refresh')) return { body: { accessToken: 'new', user: USER } };
      return new Headers(init.headers).get('Authorization') === 'Bearer new' ? { body: { ok: 1 } } : { status: 401 };
    });
    await s.client.login('a@b.co', 'password123');
    await Promise.all([s.client.get('/a'), s.client.get('/b'), s.client.get('/c')]);
    expect(s.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });

  it('can refresh again later (the in-flight marker is cleared)', async () => {
    const s = setup(() => ({ body: { accessToken: 't', user: USER } }));
    await s.client.restore();
    await s.client.restore();
    expect(s.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(2);
  });

  it('clears the in-flight marker even if fetch throws immediately', async () => {
    const s = setup(() => ({ body: { accessToken: 't', user: USER } }));
    s.fakeFetch.mockImplementationOnce(() => { throw new TypeError('sync failure'); });
    await expect(s.client.restore()).resolves.toBe(false);
    await expect(s.client.restore()).resolves.toBe(true); // not stuck on the failed attempt
  });
});

describe('guest cart', () => {
  it('remembers the cart id handed out on the first add and sends it afterwards', async () => {
    const { client, calls, data } = setup(() => ({ body: { ...EMPTY_CART, id: 'cart_1', itemCount: 1 } }));
    await client.addToCart('v1', 1);
    expect(calls[0].headers.get('X-Cart-Id')).toBeNull();
    expect(data.get('koma_cart_id')).toBe('cart_1');
    await client.getCart();
    expect(calls[1].headers.get('X-Cart-Id')).toBe('cart_1');
  });

  it('switches to a new id if the server issues one (old cart expired)', async () => {
    let n = 0;
    const { client, data } = setup(() => ({ body: { ...EMPTY_CART, id: `cart_${++n}` } }));
    await client.addToCart('v1', 1);
    await client.addToCart('v1', 1);
    expect(data.get('koma_cart_id')).toBe('cart_2');
  });

  it('does not store an id when the cart is empty and has none', async () => {
    const { client, data } = setup(() => ({ body: EMPTY_CART }));
    await client.getCart();
    expect(data.has('koma_cart_id')).toBe(false);
  });

  it('sends add, set and remove to the right routes', async () => {
    const { client, calls } = setup(() => ({ body: EMPTY_CART }));
    await client.addToCart('v1', 2);
    await client.setCartQuantity('v1', 5);
    await client.removeFromCart('v1');
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['POST', '/cart/items', { variantId: 'v1', quantity: 2 }],
      ['PATCH', '/cart/items/v1', { quantity: 5 }],
      ['DELETE', '/cart/items/v1', undefined],
    ]);
  });

  it('works when storage is unavailable (private mode): no crash, just no memory', async () => {
    const boom = () => { throw new Error('blocked'); };
    const client = createClient({
      fetch: (async () => new Response(JSON.stringify({ ...EMPTY_CART, id: 'c1' }), { status: 200 })) as unknown as typeof fetch,
      storage: { getItem: boom, setItem: boom, removeItem: boom },
      baseUrl: BASE,
    });
    await expect(client.addToCart('v1', 1)).resolves.toMatchObject({ id: 'c1' });
  });

  it('works with no storage at all (server render)', async () => {
    const client = createClient({
      fetch: (async () => new Response(JSON.stringify(EMPTY_CART), { status: 200 })) as unknown as typeof fetch,
      storage: null, baseUrl: BASE,
    });
    await expect(client.getCart()).resolves.toEqual(EMPTY_CART);
  });
});

describe('merging the guest cart on login', () => {
  const server = (mergeStatus = 201): Handler => (url) => {
    if (url.endsWith('/auth/login') || url.endsWith('/auth/register')) return { body: { accessToken: 't', user: USER } };
    if (url.endsWith('/cart/merge')) return mergeStatus === 201 ? { status: 201, body: EMPTY_CART } : { status: mergeStatus, body: { message: 'nope' } };
    return { body: {} };
  };

  it('merges the guest cart after login, then forgets the guest id', async () => {
    const s = setup(server());
    s.data.set('koma_cart_id', 'guest_9');
    await s.client.login('a@b.co', 'password123');
    const merge = s.calls.find((c) => c.path === '/cart/merge')!;
    expect(merge.body).toEqual({ guestCartId: 'guest_9' });
    expect(merge.headers.get('Authorization')).toBe('Bearer t');
    expect(s.data.has('koma_cart_id')).toBe(false);
  });

  it('also merges after registering', async () => {
    const s = setup(server());
    s.data.set('koma_cart_id', 'guest_1');
    await s.client.register('Asha', 'a@b.co', 'password123');
    expect(s.calls.some((c) => c.path === '/cart/merge')).toBe(true);
  });

  it('does nothing extra when there is no guest cart', async () => {
    const s = setup(server());
    await s.client.login('a@b.co', 'password123');
    expect(s.calls.map((c) => c.path)).toEqual(['/auth/login']);
  });

  it('still logs in, and drops the id, if the merge fails', async () => {
    const s = setup(server(500));
    s.data.set('koma_cart_id', 'guest_2');
    await expect(s.client.login('a@b.co', 'password123')).resolves.toEqual(USER);
    expect(s.client.isLoggedIn()).toBe(true);
    expect(s.data.has('koma_cart_id')).toBe(false);
  });

  it('stops sending the guest header once logged in, and keeps the cart id out of storage', async () => {
    const s = setup((url) => url.endsWith('/auth/login')
      ? { body: { accessToken: 't', user: USER } }
      : { body: { ...EMPTY_CART, id: 'account_cart' } });
    await s.client.login('a@b.co', 'password123');
    await s.client.addToCart('v1', 1);
    expect(s.calls.at(-1)!.headers.get('X-Cart-Id')).toBeNull();
    expect(s.data.has('koma_cart_id')).toBe(false); // account carts are found by login, not by id
  });
});
