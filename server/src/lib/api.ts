/**
 * Typed fetch wrapper for the fleet-web API.
 * Prepends /api to all paths and throws on non-OK responses.
 */

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = '/api' + path;
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
