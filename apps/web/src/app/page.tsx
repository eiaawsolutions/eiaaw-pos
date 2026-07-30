'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('admin@eiaawsolutions.com');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await api<{ token: string; user: any }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setToken(res.token);
      sessionStorage.setItem('eiaaw_user', JSON.stringify(res.user));
      router.push('/pos');
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <form onSubmit={submit} className="card" style={{ width: 380, display: 'grid', gap: 14 }}>
        <div>
          <h1 style={{ fontSize: 24 }}>EIAAW POS</h1>
          <p className="muted">AI-native Point of Sale — sign in</p>
        </div>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p style={{ color: 'var(--red)', fontSize: 13 }}>{error}</p>}
        <button className="btn" type="submit">
          Sign in
        </button>
        <p className="muted">Terminal · Dashboard · Back-office</p>
      </form>
    </main>
  );
}
