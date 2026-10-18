'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCart, useSession } from './Providers';

export default function HeaderNav() {
  const { user, ready, logout } = useSession();
  const { count } = useCart();
  const router = useRouter();

  return (
    <nav className="nav" aria-label="Account">
      {ready && user ? (
        <>
          <Link href="/orders">Orders</Link>
          <span className="muted">Hi, {user.name.split(' ')[0]}</span>
          <button
            type="button"
            className="linklike"
            onClick={async () => { await logout(); router.push('/'); }}
          >
            Log out
          </button>
        </>
      ) : ready ? (
        <Link href="/login">Log in</Link>
      ) : null}
      <Link href="/cart" className="cartlink">
        Cart{count > 0 && <span className="badge" aria-label={`${count} items`}>{count}</span>}
      </Link>
    </nav>
  );
}
