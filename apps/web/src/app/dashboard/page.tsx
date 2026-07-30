'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { MONEY, type DashboardStats } from '@eiaaw/shared';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
} from 'recharts';

const COLORS = ['#38bdf8', '#22c55e', '#f59e0b', '#8b5cf6', '#ef4444', '#14b8a6'];

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      api<DashboardStats>('/reports/dashboard')
        .then(setStats)
        .catch((e) => setError(e.message));
    load();
    const id = setInterval(load, 15_000); // live refresh
    return () => clearInterval(id);
  }, []);

  if (error)
    return (
      <main style={{ padding: 24 }}>
        <p style={{ color: 'var(--red)' }}>
          {error} — <a href="/">sign in</a>
        </p>
      </main>
    );
  if (!stats)
    return (
      <main style={{ padding: 24 }}>
        <p className="muted">Loading dashboard…</p>
      </main>
    );

  const hourly = stats.hourlySales.map((h) => ({
    ...h,
    label: new Date(h.hour).getHours() + ':00',
    rm: h.sales / 100,
  }));
  const daily = stats.salesByDay.map((d) => ({ ...d, rm: d.sales / 100, label: d.date.slice(5) }));
  const tenders = stats.tenderMix.map((t) => ({ name: t.tender, value: t.amount / 100 }));
  const top = stats.topProducts.map((t) => ({ ...t, rm: t.sales / 100 }));

  return (
    <main style={{ padding: 20, display: 'grid', gap: 16 }}>
      <div className="topbar" style={{ borderRadius: 12 }}>
        <strong>EIAAW POS · Live Dashboard</strong>
        <div style={{ display: 'flex', gap: 14 }}>
          <a href="/pos">Terminal</a>
          <a href="/import">AI Import</a>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
        <Stat label="Today's sales" value={MONEY.fmt(stats.todaySales)} />
        <Stat label="Orders" value={String(stats.todayOrders)} />
        <Stat label="Avg ticket" value={MONEY.fmt(stats.avgTicket)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Sales by hour (today)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={hourly}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="label" stroke="#94a3b8" />
              <YAxis stroke="#94a3b8" />
              <Tooltip
                formatter={(v: any) => `RM ${Number(v).toFixed(2)}`}
                contentStyle={{ background: '#1e293b', border: 'none' }}
              />
              <Area dataKey="rm" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.25} name="Sales" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Tender mix (today)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={tenders}
                dataKey="value"
                nameKey="name"
                innerRadius={50}
                outerRadius={85}
                label={(e: any) => e.name}
              >
                {tenders.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: any) => `RM ${Number(v).toFixed(2)}`}
                contentStyle={{ background: '#1e293b', border: 'none' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Top products (today)</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={top} layout="vertical">
              <XAxis type="number" stroke="#94a3b8" />
              <YAxis type="category" dataKey="name" width={140} stroke="#94a3b8" />
              <Tooltip
                formatter={(v: any) => `RM ${Number(v).toFixed(2)}`}
                contentStyle={{ background: '#1e293b', border: 'none' }}
              />
              <Bar dataKey="rm" fill="#22c55e" name="Sales" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 10 }}>Sales — last 14 days</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="label" stroke="#94a3b8" />
              <YAxis stroke="#94a3b8" />
              <Tooltip
                formatter={(v: any) => `RM ${Number(v).toFixed(2)}`}
                contentStyle={{ background: '#1e293b', border: 'none' }}
              />
              <Bar dataKey="rm" fill="#8b5cf6" name="Sales" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="muted">
        Auto-refreshes every 15s · Interactive drill-downs, date filters and AI natural-language analytics
        land in v1.0.
      </p>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <p className="muted">{label}</p>
      <p style={{ fontSize: 30, fontWeight: 800, marginTop: 4 }}>{value}</p>
    </div>
  );
}
