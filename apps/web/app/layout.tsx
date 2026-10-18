import './globals.css';
import Link from 'next/link';
import HeaderNav from '../components/HeaderNav';
import { Providers } from '../components/Providers';

export const metadata = { title: 'KOMA', description: 'KOMA online store' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="header">
            <div className="wrap">
              <Link href="/" className="logo">KOMA</Link>
              <form className="search" action="/products">
                <input name="search" placeholder="Search products" aria-label="Search products" />
                <button type="submit">Search</button>
              </form>
              <HeaderNav />
            </div>
          </header>
          {children}
          <footer className="footer">
            <div className="wrap">KOMA, Dehradun, Uttarakhand</div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
