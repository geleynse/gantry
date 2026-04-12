/**
 * Typed fetch wrapper for the fleet-web API.
 * Prepends /api to all paths and throws on non-OK responses.
 */

export interface ApiError extends Error {
  status: number;
  body: string;
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && 'status' in err && 'body' in err;
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = '/api' + path;
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    const error = new Error(`API ${res.status}: ${text}`) as ApiError;
    error.status = res.status;
    error.body = text;
    throw error;
  }
  return res.json() as Promise<T>;
}
