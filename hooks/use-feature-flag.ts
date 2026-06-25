'use client';

/**
 * useFeatureFlag — Issue #837
 *
 * React hook for feature flag evaluation on the frontend.
 * - Fetches from /api/feature-flags/evaluate (cached edge route)
 * - Returns { enabled, loading } — components render nothing while loading
 * - SWR/React Query not required; uses built-in fetch + state
 *
 * Usage:
 *   const { enabled } = useFeatureFlag('live_streaming');
 *   if (!enabled) return null;
 */

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';

interface UseFlagResult {
  enabled: boolean;
  loading: boolean;
}

// In-memory cache to avoid re-fetching on every render
const memCache = new Map<string, { result: boolean; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

export function useFeatureFlag(flagName: string): UseFlagResult {
  const { data: session } = useSession();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function evaluate() {
      const cacheKey = `${flagName}:${session?.user?.email ?? 'anon'}`;
      const cached = memCache.get(cacheKey);

      if (cached && cached.expiresAt > Date.now()) {
        if (!cancelled) {
          setEnabled(cached.result);
          setLoading(false);
        }
        return;
      }

      try {
        const params = new URLSearchParams({ flag: flagName });
        if (session?.user) {
          params.set('userId', (session.user as { id?: string }).id ?? '');
        }

        const res = await fetch(`/api/feature-flags/evaluate?${params}`, {
          cache: 'no-store',
        });

        if (!res.ok) throw new Error('Flag evaluation failed');

        const data: { enabled: boolean } = await res.json();

        memCache.set(cacheKey, {
          result: data.enabled,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });

        if (!cancelled) {
          setEnabled(data.enabled);
        }
      } catch {
        // On error, default to disabled (safe)
        if (!cancelled) setEnabled(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    evaluate();

    return () => {
      cancelled = true;
    };
  }, [flagName, session]);

  return { enabled, loading };
}

/**
 * Evaluate multiple flags at once.
 *
 * Usage:
 *   const flags = useFeatureFlags(['live_streaming', 'ar_portfolio']);
 *   if (flags.live_streaming) { ... }
 */
export function useFeatureFlags(
  flagNames: string[],
): Record<string, boolean> & { loading: boolean } {
  const results = flagNames.map(useFeatureFlag);
  const loading = results.some((r) => r.loading);
  const map = Object.fromEntries(
    flagNames.map((name, i) => [name, results[i].enabled]),
  ) as Record<string, boolean>;

  return { ...map, loading };
}
