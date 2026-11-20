import type { PipeParams, SimulationMetrics, SimulationResponse } from './types';

// In production on Cloudflare Pages, set VITE_API_BASE to your Worker URL
// (or leave empty if Worker is mounted on the same domain under /api/*).
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function runSimulation(
  params: PipeParams,
  options?: { force?: boolean; turnstileToken?: string }
): Promise<SimulationResponse> {
  const resp = await fetch(resolveApiUrl('/api/simulate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...params,
      force: Boolean(options?.force),
      turnstile_token: options?.turnstileToken,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error || `Simulation request failed (${resp.status})`);
  }
  return data as SimulationResponse;
}

export async function fetchCachedCases(): Promise<SimulationMetrics[]> {
  const resp = await fetch(resolveApiUrl('/api/cases'));
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data?.cases || []) as SimulationMetrics[];
}

export async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(resolveApiUrl(url));
  if (!resp.ok) {
    throw new Error(`Failed loading ${url} (${resp.status})`);
  }
  return resp.arrayBuffer();
}
