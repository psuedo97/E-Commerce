import AuthForm from '../../components/AuthForm';
import { safeNext } from '../../lib/redirect';

export const metadata = { title: 'Log in | KOMA' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <AuthForm mode="login" next={safeNext(next)} />;
}
