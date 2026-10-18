// Browser-side API client: keeps the login in memory, refreshes it when it expires, and remembers
// a guest's cart id so the cart survives page reloads and can be merged after login.
import type { Cart, User } from './types';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: unknown) {
    super(message);
  }
}

export interface ClientDeps {
  fetch: typeof fetch;
  /** localStorage in the browser; null where unavailable (server render, private mode). */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  baseUrl: string; // e.g. http://localhost:4000/api/v1
}

const CART_KEY = 'koma_cart_id';

/** The API returns `message` as a string, or a list for validation errors. */
export function messageOf(body: unknown): string {
  const m = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(m)) return m.join(', ');
  if (typeof m === 'string') return m;
  return 'Something went wrong. Please try again.';
}

export function createClient(deps: ClientDeps) {
  let accessToken: string | null = null;
  let user: User | null = null;
  let refreshing: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const store = {
    get: () => { try { return deps.storage?.getItem(CART_KEY) ?? null; } catch { return null; } },
    set: (id: string) => { try { deps.storage?.setItem(CART_KEY, id); } catch { /* storage unavailable */ } },
    clear: () => { try { deps.storage?.removeItem(CART_KEY); } catch { /* storage unavailable */ } },
  };

  function setSession(token: string | null, u: User | null) {
    accessToken = token;
    user = u;
    notify();
  }

  async function send(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (accessToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    } else {
      const cartId = store.get();
      if (cartId) headers.set('X-Cart-Id', cartId);
    }
    // credentials: the refresh token lives in an httpOnly cookie set by the API.
    const res = await deps.fetch(`${deps.baseUrl}${path}`, { ...init, headers, credentials: 'include' });
    if (res.status === 401 && accessToken && retry && path !== '/auth/refresh') {
      // Access tokens last 15 minutes; try to get a new one once, then repeat the request.
      if (await refresh()) return send(path, init, false);
    }
    return res;
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await send(path, init);
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(res.status, messageOf(body), body);
    return body as T;
  }

  const json = (method: string, body?: unknown): RequestInit => ({
    method, body: body === undefined ? undefined : JSON.stringify(body),
  });

  /** Single-flight: concurrent expired requests share one refresh call. */
  async function doRefresh(): Promise<boolean> {
    try {
      const res = await deps.fetch(`${deps.baseUrl}/auth/refresh`, { method: 'POST', credentials: 'include' });
      if (!res.ok) { setSession(null, null); return false; }
      const data = (await res.json()) as { accessToken: string; user: User };
      setSession(data.accessToken, data.user);
      return true;
    } catch {
      return false; // network trouble: keep the current session, the caller will surface the error
    }
  }

  function refresh(): Promise<boolean> {
    if (refreshing) return refreshing;
    const attempt: Promise<boolean> = doRefresh().finally(() => {
      if (refreshing === attempt) refreshing = null;
    });
    refreshing = attempt;
    return attempt;
  }

  /** After logging in, fold the guest cart (if any) into the account's cart. */
  async function mergeGuestCart() {
    const guestCartId = store.get();
    if (!guestCartId) return;
    try {
      await request<Cart>('/cart/merge', json('POST', { guestCartId }));
    } finally {
      store.clear(); // merged, or it no longer exists; either way the id is spent
    }
  }

  async function authenticate(path: string, body: unknown) {
    const data = await request<{ accessToken: string; user: User }>(path, json('POST', body));
    setSession(data.accessToken, data.user);
    await mergeGuestCart().catch(() => undefined); // a failed merge must not block login
    return data.user;
  }

  /** Remember a guest cart's id as soon as the API hands one out. */
  function rememberCart(cart: Cart): Cart {
    if (!accessToken && cart.id) store.set(cart.id);
    return cart;
  }

  return {
    request,
    get: <T>(path: string) => request<T>(path),
    post: <T>(path: string, body?: unknown) => request<T>(path, json('POST', body)),
    patch: <T>(path: string, body: unknown) => request<T>(path, json('PATCH', body)),
    del: <T>(path: string) => request<T>(path, json('DELETE')),

    /** Call once when the app loads: restores the session from the refresh cookie. */
    restore: () => refresh(),
    login: (email: string, password: string) => authenticate('/auth/login', { email, password }),
    register: (name: string, email: string, password: string, phone?: string) =>
      authenticate('/auth/register', { name, email, password, phone: phone || undefined }),
    async logout() {
      try { await request('/auth/logout', json('POST')); } catch { /* the local logout below still applies */ }
      setSession(null, null);
    },

    getCart: async () => rememberCart(await request<Cart>('/cart')),
    addToCart: async (variantId: string, quantity: number) =>
      rememberCart(await request<Cart>('/cart/items', json('POST', { variantId, quantity }))),
    setCartQuantity: async (variantId: string, quantity: number) =>
      rememberCart(await request<Cart>(`/cart/items/${variantId}`, json('PATCH', { quantity }))),
    removeFromCart: async (variantId: string) =>
      rememberCart(await request<Cart>(`/cart/items/${variantId}`, json('DELETE'))),

    getUser: () => user,
    isLoggedIn: () => accessToken !== null,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export type Client = ReturnType<typeof createClient>;

const ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'http://localhost:4000';

/** The app-wide instance. Safe to import on the server: storage is simply absent there. */
export const client = createClient({
  fetch: (...args) => fetch(...args),
  storage: typeof window === 'undefined' ? null : window.localStorage,
  baseUrl: `${ORIGIN}/api/v1`,
});
