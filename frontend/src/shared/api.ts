// The only way the UI talks to the server. Every screen's data comes through here.
//
// - Same origin, HttpOnly session cookie (set by the server at login).
// - Errors arrive as { error, code }; they become ApiError with the server's own message.
// - 401 calls the registered handler so the app shows its login screen.
// - Network failures are reported as status 0 so callers can show "offline" and retry safely.

export class ApiError extends Error {
  status: number;
  code: string;
  body: unknown;
  constructor(status: number, message: string, code = 'error', body: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
  get offline() {
    return this.status === 0;
  }
  // Nothing was saved on the server, so the same request can be sent again.
  get retryable() {
    return this.status === 0 || this.status === 503;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the market server. Check your connection.', 'offline');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (res.ok) return data as T;
  const err = (data || {}) as { error?: string; code?: string };
  if (res.status === 401 && onUnauthorized && !path.endsWith('/login')) onUnauthorized();
  // 422 = order rejected: the body still carries the recorded order.
  throw new ApiError(res.status, err.error || `Request failed (${res.status})`, err.code, data);
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Idempotency keys for orders: created once per confirmation, reused for every retry of it.
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
