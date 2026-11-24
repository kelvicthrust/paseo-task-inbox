import { useCallback, useEffect, useRef, useState } from 'react';

export function useInboxQuery<T>(read: () => Promise<T>, interval: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const readRef = useRef(read);
  const revision = useRef(0);
  readRef.current = read;

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const result = await readRef.current();
      if (current === revision.current) {
        setData(result);
        setError(undefined);
      }
    } catch (problem) {
      if (current === revision.current) setError(errorMessage(problem));
    }
  }, []);

  useEffect(() => {
    let live = true;
    let next: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (live) next = setTimeout(poll, interval);
    }
    void poll();
    return () => {
      live = false;
      revision.current++;
      clearTimeout(next);
    };
  }, [interval, refresh]);

  return { data, error, refresh };
}

export function errorMessage(problem: unknown): string {
  return problem instanceof Error ? problem.message : 'Task Inbox is unavailable.';
}
