/**
 * Sequence Lock Manager v2 — Issue #838
 *
 * Improvements over v1:
 *  1. Uses SELECT FOR UPDATE SKIP LOCKED to avoid lock contention
 *  2. Pre-fetches a pool of 10 sequence numbers per account
 *  3. Failed transactions (wrong sequence) auto-retry with next pool slot
 *  4. Pool is refilled asynchronously when it drops below threshold
 *
 * The drainer (see transaction-queue-drainer.ts) runs at 100ms intervals,
 * not per-request, so individual requests never block each other.
 */

import { prisma } from "@/lib/prisma";

const POOL_SIZE = 10;        // Pre-fetch window
const POOL_REFILL_AT = 3;    // Refill when fewer than 3 remain
const LOCK_TIMEOUT_MS = 5000;

// ── Raw SQL helpers ────────────────────────────────────────────────────────────

/**
 * Acquire the sequence lock row using SELECT FOR UPDATE SKIP LOCKED.
 * Returns the lock data immediately or null if another process holds it.
 * This eliminates contention — callers skip instead of waiting.
 */
async function acquireSequenceLockSkipLocked(accountId: string): Promise<{
  sequence: bigint;
  lockedBy: string;
  expiresAt: Date;
} | null> {
  const rows = await prisma.$queryRaw<
    Array<{ sequence: bigint; lockedBy: string; expiresAt: Date }>
  >`
    SELECT sequence, "lockedBy", "expiresAt"
    FROM "SequenceLock"
    WHERE "accountId" = ${accountId}
      AND ("expiresAt" < NOW() OR "lockedBy" = '')
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `;

  return rows[0] ?? null;
}

/**
 * Claim a single pre-fetched sequence from the pool using SKIP LOCKED.
 * Returns the sequence number or null if pool is empty.
 */
export async function claimPooledSequence(
  accountId: string,
): Promise<bigint | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; sequence: bigint }>>`
    SELECT id, sequence
    FROM "SequencePool"
    WHERE "accountId" = ${accountId}
      AND reserved = FALSE
    ORDER BY sequence ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `;

  if (rows.length === 0) return null;

  const { id, sequence } = rows[0];
  await prisma.sequencePool.update({
    where: { id },
    data: { reserved: true, reservedAt: new Date() },
  });

  return sequence;
}

/**
 * Mark a pooled sequence as used (committed on-chain).
 */
export async function markSequenceUsed(
  accountId: string,
  sequence: bigint,
): Promise<void> {
  await prisma.sequencePool.updateMany({
    where: { accountId, sequence, reserved: true },
    data: { usedAt: new Date() },
  });
}

/**
 * Return a reserved-but-unused sequence back to the pool (e.g. on retry).
 */
export async function releaseSequenceBack(
  accountId: string,
  sequence: bigint,
): Promise<void> {
  await prisma.sequencePool.updateMany({
    where: { accountId, sequence, reserved: true, usedAt: null },
    data: { reserved: false, reservedAt: null },
  });
}

// ── Pool refill ────────────────────────────────────────────────────────────────

/** Tracks in-flight refill promises per account to prevent double-filling */
const refillInProgress = new Map<string, Promise<void>>();

/**
 * Fetch the next N sequence numbers from the Soroban RPC for an account
 * and insert them into the pool.
 */
export async function refillSequencePool(
  accountId: string,
  currentNetworkSequence: bigint,
  count = POOL_SIZE,
): Promise<void> {
  // Prevent duplicate refill for the same account
  if (refillInProgress.has(accountId)) {
    return refillInProgress.get(accountId)!;
  }

  const refillPromise = (async () => {
    try {
      // Find the highest sequence already in the pool for this account
      const highest = await prisma.sequencePool.findFirst({
        where: { accountId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });

      const startSeq = highest
        ? highest.sequence + 1n
        : currentNetworkSequence + 1n;

      const newEntries = Array.from({ length: count }, (_, i) => ({
        accountId,
        sequence: startSeq + BigInt(i),
      }));

      await prisma.sequencePool.createMany({
        data: newEntries,
        skipDuplicates: true,
      });

      console.debug(
        `[seq-pool] Refilled ${count} sequences for ${accountId} starting at ${startSeq}`,
      );
    } finally {
      refillInProgress.delete(accountId);
    }
  })();

  refillInProgress.set(accountId, refillPromise);
  return refillPromise;
}

/**
 * Check pool depth and trigger async refill if below threshold.
 * Non-blocking — called as a side effect.
 */
export async function checkAndRefillPool(
  accountId: string,
  fetchCurrentNetworkSequence: () => Promise<bigint>,
): Promise<void> {
  const available = await prisma.sequencePool.count({
    where: { accountId, reserved: false },
  });

  if (available < POOL_REFILL_AT) {
    // Fire-and-forget: don't await so the caller isn't blocked
    fetchCurrentNetworkSequence()
      .then((seq) => refillSequencePool(accountId, seq))
      .catch((err) =>
        console.error(`[seq-pool] Refill error for ${accountId}:`, err),
      );
  }
}

// ── High-level acquire with retry ─────────────────────────────────────────────

export interface AcquireSequenceOptions {
  /** Fetch current on-chain sequence — used if pool is empty */
  fetchNetworkSequence: () => Promise<bigint>;
  /** Max retry attempts on "bad sequence" errors (default 5) */
  maxRetries?: number;
}

/**
 * Acquire a sequence number for a transaction.
 * Tries the pool first (fast path); falls back to RPC if pool is empty.
 * Auto-retries with the next sequence on "bad sequence" errors.
 */
export async function acquireSequence(
  accountId: string,
  opts: AcquireSequenceOptions,
): Promise<bigint> {
  const { fetchNetworkSequence, maxRetries = 5 } = opts;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fast path: claim from pool
    let seq = await claimPooledSequence(accountId);

    if (seq == null) {
      // Pool empty — fetch from network and refill
      const networkSeq = await fetchNetworkSequence();
      await refillSequencePool(accountId, networkSeq);
      seq = await claimPooledSequence(accountId);
    }

    if (seq == null) {
      // Shouldn't happen after refill, but guard against it
      await sleep(100 * (attempt + 1));
      continue;
    }

    // Trigger background refill check (non-blocking)
    checkAndRefillPool(accountId, fetchNetworkSequence).catch(() => {});

    return seq;
  }

  throw new Error(
    `[seq-manager] Failed to acquire sequence for ${accountId} after ${maxRetries} attempts`,
  );
}

// ── Cleanup helpers ────────────────────────────────────────────────────────────

/**
 * Purge stale pool entries that were reserved but never used
 * (e.g. crashed worker). Called by the drainer periodically.
 */
export async function purgeStaleReservations(
  accountId: string,
  staleAfterMs = LOCK_TIMEOUT_MS,
): Promise<number> {
  const staleThreshold = new Date(Date.now() - staleAfterMs);
  const { count } = await prisma.sequencePool.updateMany({
    where: {
      accountId,
      reserved: true,
      usedAt: null,
      reservedAt: { lt: staleThreshold },
    },
    data: { reserved: false, reservedAt: null },
  });
  return count;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
