'use client';

/**
 * AI Auto-Onboarding — drop in the event script + item documents
 * (barcode/QR lists, price sheets). The system extracts items and, for
 * ANYTHING not explicitly stated, asks clarification questions. It will not
 * guess. Commit is only possible at zero open questions.
 */
import { useState } from 'react';
import { api } from '@/lib/api';

type Session = {
  id: string;
  status: string;
  eventNotes?: string | null;
  questions?: { id: string; itemRef: string | null; field: string; question: string }[] | null;
  items: { ref: string; name?: string | null; sku?: string | null; barcode?: string | null; price?: number | null; category?: string | null; missing: string[] }[];
};

export default function ImportPage() {
  const [name, setName] = useState('Event import');
  const [source, setSource] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setMsg('');
    try {
      await fn();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const s = await api<Session>('/ai/onboarding/sessions', { method: 'POST', body: JSON.stringify({ name, sourceText: source }) });
      setSession(s);
      setAnswers({});
    });

  const submitAnswers = () =>
    run(async () => {
      const s = await api<Session>(`/ai/onboarding/sessions/${session!.id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) });
      setSession(s);
      setAnswers({});
    });

  const commit = () =>
    run(async () => {
      const r = await api<{ committed: number }>(`/ai/onboarding/sessions/${session!.id}/commit`, { method: 'POST', body: JSON.stringify({ outletId: 'outlet-hq' }) });
      setMsg(`✅ ${r.committed} items are live and ready to sell. Open the Terminal to start selling.`);
      setSession(null);
      setSource('');
    });

  const questions = session?.questions ?? [];

  return (
    <main style={{ padding: 20, maxWidth: 960, margin: '0 auto', display: 'grid', gap: 16 }}>
      <div className="topbar" style={{ borderRadius: 12 }}>
        <strong>AI Import — auto-configure items for an event</strong>
        <div style={{ display: 'flex', gap: 14 }}><a href="/pos">Terminal</a><a href="/dashboard">Dashboard</a></div>
      </div>

      {!session && (
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <p className="muted">
            Paste (or upload in v1.0) the event script and item documents — barcode/QR lists with pricing. The system
            extracts everything explicitly stated and asks about anything unclear. It never assumes a price or barcode.
          </p>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Import name (e.g. Stadium Merch Night)" />
          <textarea
            rows={12}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={'Drop document content here, e.g.\n\nEvent: Merdeka Mega Sale, 31 Aug, Hall 5, 3 booths\nTeh Tarik, 9551000000017, RM4.50\nEvent T-Shirt L, 9551000000208, RM49.00\nTote Bag, 9551000000222'}
          />
          <button className="btn" disabled={busy || !source.trim()} onClick={start}>{busy ? 'Extracting…' : 'Extract items'}</button>
        </div>
      )}

      {session && (
        <>
          {session.eventNotes && (
            <div className="card"><strong>Event context detected:</strong> <span className="muted">{session.eventNotes}</span></div>
          )}
          <div className="card">
            <h3 style={{ marginBottom: 10 }}>Extracted items ({session.items.length}) — status: {session.status}</h3>
            <table className="tbl">
              <thead><tr><th>Ref</th><th>Name</th><th>Barcode</th><th>Price</th><th>Category</th><th>Missing</th></tr></thead>
              <tbody>
                {session.items.map((it) => (
                  <tr key={it.ref}>
                    <td>{it.ref}</td>
                    <td>{it.name ?? <em style={{ color: 'var(--amber)' }}>?</em>}</td>
                    <td>{it.barcode ?? <em style={{ color: 'var(--amber)' }}>?</em>}</td>
                    <td>{it.price != null ? 'RM ' + (it.price / 100).toFixed(2) : <em style={{ color: 'var(--amber)' }}>?</em>}</td>
                    <td>{it.category ?? '—'}</td>
                    <td>{it.missing.length ? <span style={{ color: 'var(--red)' }}>{it.missing.join(', ')}</span> : <span style={{ color: 'var(--green)' }}>complete</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {questions.length > 0 && (
            <div className="card" style={{ display: 'grid', gap: 12 }}>
              <h3>The system needs {questions.length} clarification{questions.length > 1 ? 's' : ''} — it will not assume:</h3>
              {questions.map((q) => (
                <div key={q.id} style={{ display: 'grid', gap: 6 }}>
                  <label className="muted">{q.question}</label>
                  <input value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} placeholder="Your answer" />
                </div>
              ))}
              <button className="btn" disabled={busy} onClick={submitAnswers}>{busy ? 'Re-checking…' : 'Submit answers'}</button>
            </div>
          )}

          {session.status === 'READY' && (
            <div className="card" style={{ display: 'grid', gap: 10 }}>
              <p style={{ color: 'var(--green)', fontWeight: 700 }}>All items fully resolved — zero open questions.</p>
              <button className="btn-green" disabled={busy} onClick={commit}>Commit to catalog — ready to sell</button>
            </div>
          )}

          <button className="btn-ghost" onClick={() => setSession(null)}>Start over</button>
        </>
      )}

      {msg && <div className="card">{msg}</div>}
    </main>
  );
}
