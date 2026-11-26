// Polling until the API has a push channel (PRD §9.6 allows authenticated
// polling). "Live" means the last request succeeded, so the UI never shows a
// live indicator over stale data.

import { useCallback, useEffect, useRef, useState } from "react";

/** usePolling loads now, then every interval, and again whenever deps change. */
export function usePolling<T>(load: () => Promise<T>, deps: unknown[], interval_ms: number) {
  const [data, setData] = useState<T | null>(null);
  const [isLive, setIsLive] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setIsLive(true);
    } catch {
      setIsLive(false);
    }
  }, []);

  useEffect(() => {
    setData(null);
    void refresh();
    const timer = setInterval(() => void refresh(), interval_ms);
    return () => clearInterval(timer);
    // deps, not load, decide when to start over: load is a new closure every render.
  }, deps);

  return { data, isLive, refresh };
}
