'use client';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  // In production Next hides the message; in development it shows e.g. "Cannot reach the API".
  return (
    <main className="wrap error">
      <h1>Something went wrong</h1>
      <p>{process.env.NODE_ENV === 'development' ? error.message : 'Please try again in a moment.'}</p>
      <button className="btn" onClick={reset}>Try again</button>
    </main>
  );
}
