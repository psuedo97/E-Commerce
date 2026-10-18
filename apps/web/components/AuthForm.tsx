'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { messageOf } from '../lib/client';
import { useSession } from './Providers';

export default function AuthForm({ mode, next }: { mode: 'login' | 'register'; next: string }) {
  const { login, register } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isLogin = mode === 'login';
  const nextQuery = next === '/' ? '' : `?next=${encodeURIComponent(next)}`;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    setBusy(true);
    setError(null);
    try {
      if (isLogin) await login(get('email'), String(f.get('password') ?? ''));
      else await register(get('name'), get('email'), String(f.get('password') ?? ''), get('phone'));
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : messageOf(null));
      setBusy(false);
    }
  }

  return (
    <main className="wrap narrow">
      <h1>{isLogin ? 'Log in' : 'Create your account'}</h1>
      <form onSubmit={onSubmit} className="form">
        {!isLogin && (
          <label>Full name<input name="name" required minLength={2} maxLength={80} autoComplete="name" /></label>
        )}
        <label>Email<input name="email" type="email" required autoComplete="email" /></label>
        {!isLogin && (
          <label>
            Mobile number <span className="muted">(optional)</span>
            <input name="phone" inputMode="numeric" pattern="[6-9][0-9]{9}" maxLength={10} placeholder="10-digit number" autoComplete="tel-national" />
          </label>
        )}
        <label>
          Password{!isLogin && <span className="muted"> (at least 8 characters)</span>}
          <input name="password" type="password" required minLength={isLogin ? 1 : 8} maxLength={72} autoComplete={isLogin ? 'current-password' : 'new-password'} />
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn" disabled={busy}>{busy ? 'Please wait...' : isLogin ? 'Log in' : 'Create account'}</button>
      </form>
      <p className="muted">
        {isLogin ? (
          <>New here? <Link href={`/register${nextQuery}`}>Create an account</Link></>
        ) : (
          <>Already have an account? <Link href={`/login${nextQuery}`}>Log in</Link></>
        )}
      </p>
    </main>
  );
}
