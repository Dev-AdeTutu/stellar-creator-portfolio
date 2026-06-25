/**
 * Feature flag middleware for Next.js API routes — Issue #837
 *
 * Usage (in any route handler):
 *
 *   import { withFeatureFlag } from '@/lib/feature-flags/middleware';
 *
 *   export const GET = withFeatureFlag('live_streaming', handler);
 *
 * If the flag is disabled for this user, returns 404 so the feature
 * is invisible (not just a 403 that reveals its existence).
 */

import { NextRequest, NextResponse } from 'next/server';
import { evaluateFlag, FlagContext } from './service';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';

type RouteHandler = (
  req: NextRequest,
  ctx: Record<string, unknown>,
) => Promise<NextResponse> | NextResponse;

/**
 * Wrap a route handler behind a feature flag.
 * Returns 404 if the flag is off for this user.
 */
export function withFeatureFlag(
  flagName: string,
  handler: RouteHandler,
): RouteHandler {
  return async (req, ctx) => {
    const session = await getServerSession(authOptions);

    const flagCtx: FlagContext = {
      userId: (session?.user as { id?: string })?.id,
      role: (session?.user as { role?: string })?.role,
      platform:
        (req.headers.get('x-platform') as 'ios' | 'android' | 'web') ??
        undefined,
    };

    const enabled = await evaluateFlag(flagName, flagCtx, {
      logEvaluation: true,
    });

    if (!enabled) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return handler(req, ctx);
  };
}

/**
 * Check multiple flags before executing handler.
 * All flags must be enabled.
 */
export function withFeatureFlags(
  flagNames: string[],
  handler: RouteHandler,
): RouteHandler {
  return async (req, ctx) => {
    const session = await getServerSession(authOptions);

    const flagCtx: FlagContext = {
      userId: (session?.user as { id?: string })?.id,
      role: (session?.user as { role?: string })?.role,
    };

    const results = await Promise.all(
      flagNames.map((name) =>
        evaluateFlag(name, flagCtx, { logEvaluation: false }),
      ),
    );

    if (results.some((r) => !r)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return handler(req, ctx);
  };
}
