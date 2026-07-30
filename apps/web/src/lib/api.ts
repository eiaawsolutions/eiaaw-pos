'use client';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('eiaaw_token');
}

export function setToken(token: string) {
  sessionStorage.setItem('eiaaw_token', token);
}

/**
 * A response the server did give us, and refused.
 *
 * Worth distinguishing from a network failure: the terminal keeps selling
 * through an outage by queueing, but an order the server has actively rejected
 * will be rejected identically on every retry. Queueing that one loops forever
 * and prints a receipt for a sale that never happened.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The server judged the request itself — replaying it changes nothing. */
  get isRefusal(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body?.message ?? `API error ${res.status}`, res.status);
  }
  return res.json();
}
