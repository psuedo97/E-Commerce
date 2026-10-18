'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { client } from '../lib/client';
import type { Cart, User } from '../lib/types';

type Session = {
  user: User | null;
  /** False until the first check for an existing login has finished. */
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string, phone?: string) => Promise<void>;
  logout: () => Promise<void>;
};

type CartState = {
  cart: Cart | null;
  count: number;
  refresh: () => Promise<void>;
  add: (variantId: string, quantity: number) => Promise<Cart>;
  setQuantity: (variantId: string, quantity: number) => Promise<Cart>;
  remove: (variantId: string) => Promise<Cart>;
};

const SessionContext = createContext<Session | null>(null);
const CartContext = createContext<CartState | null>(null);

export function Providers({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [cart, setCart] = useState<Cart | null>(null);

  // On first load, restore the login from the refresh cookie, then keep in step with the client.
  useEffect(() => {
    const off = client.subscribe(() => setUser(client.getUser()));
    client.restore().finally(() => {
      setUser(client.getUser());
      setReady(true);
    });
    return off;
  }, []);

  const refresh = useCallback(async () => {
    try {
      setCart(await client.getCart());
    } catch {
      /* the cart badge is a convenience; pages that need the cart show their own errors */
    }
  }, []);

  // Reload the cart once we know who the visitor is, and again when they log in or out.
  useEffect(() => {
    if (ready) void refresh();
  }, [ready, user?.id, refresh]);

  const session = useMemo<Session>(
    () => ({
      user,
      ready,
      login: async (email, password) => { await client.login(email, password); },
      register: async (name, email, password, phone) => { await client.register(name, email, password, phone); },
      logout: async () => { await client.logout(); setCart(null); },
    }),
    [user, ready],
  );

  const cartState = useMemo<CartState>(() => {
    const apply = (c: Cart) => { setCart(c); return c; };
    return {
      cart,
      count: cart?.itemCount ?? 0,
      refresh,
      add: async (variantId, quantity) => apply(await client.addToCart(variantId, quantity)),
      setQuantity: async (variantId, quantity) => apply(await client.setCartQuantity(variantId, quantity)),
      remove: async (variantId) => apply(await client.removeFromCart(variantId)),
    };
  }, [cart, refresh]);

  return (
    <SessionContext.Provider value={session}>
      <CartContext.Provider value={cartState}>{children}</CartContext.Provider>
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <Providers>');
  return ctx;
}

export function useCart(): CartState {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used inside <Providers>');
  return ctx;
}
