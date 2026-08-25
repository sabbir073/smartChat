'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api-client';

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetch once, expose loading/error/data, and allow an explicit reload.
 *
 * Deliberately small: a data-fetching library is worth adding when caching and revalidation
 * actually matter, which for these screens they do not yet. The in-flight request is aborted on
 * unmount so a slow response cannot set state on a page the person has already left.
 */
export function useResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher, deps);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setLoading(true);
    setError(null);

    run(controller.signal)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((caught: unknown) => {
        if (!active || (caught as Error).name === 'AbortError') return;
        setError(
          caught instanceof ApiError ? caught : new ApiError('UNKNOWN', 'Something went wrong', 0),
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [run, nonce]);

  return { data, error, loading, reload: () => setNonce((value) => value + 1) };
}
