import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Polled<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Fetches `fn` now, then every `ms` while the page is visible, and again whenever `deps` change.
 * `ms = 0` fetches once (plus manual reloads). A failed poll keeps the last good data and reports
 * the error, so a dropped connection never blanks the screen.
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const d = await fnRef.current();
      if (mine !== seq.current) return; // a newer request already answered
      setData(d);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    reload();
    if (!ms) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, ms);
    const onVisible = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, reload, ...deps]);

  return { data, error, loading, reload };
}

/** Milliseconds left until `deadline`, using the server's clock (never the laptop's). */
export function useCountdown(deadline: string | null | undefined, serverTime: string | null | undefined): number | null {
  const offset = useRef(0);
  useEffect(() => {
    if (serverTime) offset.current = new Date(serverTime).getTime() - Date.now();
  }, [serverTime]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  return new Date(deadline).getTime() - (now + offset.current);
}
