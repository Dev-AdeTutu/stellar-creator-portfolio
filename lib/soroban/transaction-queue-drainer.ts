/**
 * Transaction Queue Drainer — Issue #838
 *
 * Runs at 100ms intervals, not per-request.
 * Processes pending TransactionQueue entries in batches, using the
 * sequence pool to eliminate per-request RPC calls and sequence collisions.
 *
 * Architecture:
 *  - One drainer instance per server process (singleton)
 *  - Per-account concurrency = 1 (ordered submission)
 *  - On "bad sequence" error → release slot back to pool, retry with next seq
 *  - Throughput target: > 20 tx/second across all accounts
 */

import { prisma } from "@/lib/prisma";
import {
  acquireSequence,
  markSequenceUsed,
  releaseSequenceBack,
  purgeStaleReservations,
} from "./sequence-manager-v2";

const DRAIN_INTERVAL_MS = 100;
const BATCH_SIZE = 20;   // max tx per drainer tick
const MAX_ATTEMPTS = 5;

// ── Types ──────────────────────────────────────────────────────────────────────

export type DrainerStats = {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
  uptimeMs: number;
};

// Accounts currently being processed (to avoid concurrent draining per account)
const inFlight = new Set<string>();

// ── Soroban RPC stub ───────────────────────────────────────────────────────────
// Replace with your actual Soroban RPC client call

async function fetchNetworkSequenceForAccount(accountId: string): Promise<bigint> {
  // TODO: replace with real RPC:
  // const rpc = new StellarSdk.rpc.Server(process.env.SOROBAN_RPC_URL!);
  // const acc = await rpc.getAccount(accountId);
  // return BigInt(acc.sequence);
  const lock = await prisma.sequenceLock.findUnique({ where: { accountId } });
  return lock?.sequence ?? 0n;
}

async function submitToSorobanRPC(tx: {
  accountId: string;
  contractId: string;
  method: string;
  args: unknown;
  sequence: bigint;
}): Promise<string> {
  // TODO: replace with actual SDK submission
  return `0x${tx.accountId.slice(0, 8)}_${tx.sequence}`;
}

function isBadSequenceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("bad sequence") ||
    msg.includes("txBAD_SEQ") ||
    msg.includes("wrong sequence")
  );
}

// ── Per-account drainer ────────────────────────────────────────────────────────

async function drainAccount(accountId: string): Promise<void> {
  if (inFlight.has(accountId)) return; // already draining this account
  inFlight.add(accountId);

  try {
    // Get oldest pending tx for this account
    const tx = await prisma.transactionQueue.findFirst({
      where: { accountId, status: "pending" },
      orderBy: { createdAt: "asc" },
    });

    if (!tx) {
      inFlight.delete(accountId);
      return;
    }

    let sequence: bigint | null = null;

    try {
      sequence = await acquireSequence(accountId, {
        fetchNetworkSequence: () =>
          fetchNetworkSequenceForAccount(accountId),
      });

      const txHash = await submitToSorobanRPC({
        accountId,
        contractId: tx.contractId,
        method: tx.method,
        args: tx.args,
        sequence,
      });

      // Success — mark confirmed
      await prisma.$transaction([
        prisma.transactionQueue.update({
          where: { id: tx.id },
          data: {
            status: "confirmed",
            txHash,
            sequence,
            submittedAt: new Date(),
            confirmedAt: new Date(),
            attempts: tx.attempts + 1,
          },
        }),
        // Persist SorobanTransaction record
        prisma.sorobanTransaction.create({
          data: {
            accountId,
            contractId: tx.contractId,
            method: tx.method,
            sequence,
            txHash,
            status: "confirmed",
            submittedAt: new Date(),
            confirmedAt: new Date(),
          },
        }),
      ]);

      await markSequenceUsed(accountId, sequence);
    } catch (err) {
      const isBadSeq = isBadSequenceError(err);

      // Release sequence back to pool on bad-sequence so next attempt can retry
      if (sequence != null) {
        if (isBadSeq) {
          await releaseSequenceBack(accountId, sequence);
        } else {
          await markSequenceUsed(accountId, sequence); // consumed, even on failure
        }
      }

      const nextAttempts = tx.attempts + 1;
      const exhausted = nextAttempts >= MAX_ATTEMPTS;

      await prisma.transactionQueue.update({
        where: { id: tx.id },
        data: {
          attempts: nextAttempts,
          status: exhausted ? "failed" : "pending",
          error: err instanceof Error ? err.message : String(err),
          // On bad-sequence retry with slight delay (next drainer tick handles it)
        },
      });

      if (!exhausted) {
        console.warn(
          `[drainer] tx ${tx.id} attempt ${nextAttempts}/${MAX_ATTEMPTS}: ${isBadSeq ? "bad-seq, retrying" : "transient error"}`,
        );
      } else {
        console.error(`[drainer] tx ${tx.id} EXHAUSTED after ${MAX_ATTEMPTS} attempts`);
      }
    }
  } finally {
    inFlight.delete(accountId);
  }
}

// ── Global drainer ─────────────────────────────────────────────────────────────

let drainerTimer: ReturnType<typeof setInterval> | null = null;
let startedAt: number | null = null;
const stats: DrainerStats = {
  processed: 0,
  succeeded: 0,
  failed: 0,
  retried: 0,
  uptimeMs: 0,
};

async function drainerTick(): Promise<void> {
  try {
    // Find distinct accounts with pending work
    const pending = await prisma.transactionQueue.groupBy({
      by: ["accountId"],
      where: { status: "pending" },
      take: BATCH_SIZE,
    });

    await Promise.all(pending.map((r) => drainAccount(r.accountId)));

    // Periodically purge stale reservations (every ~10s)
    if (Date.now() % 10000 < DRAIN_INTERVAL_MS) {
      const accounts = await prisma.sequencePool.groupBy({
        by: ["accountId"],
        where: { reserved: true, usedAt: null },
      });
      await Promise.all(
        accounts.map((a) => purgeStaleReservations(a.accountId)),
      );
    }
  } catch (err) {
    console.error("[drainer] tick error:", err);
  }
}

/**
 * Start the global drainer — call once at server startup.
 * Safe to call multiple times (idempotent).
 */
export function startDrainer(): void {
  if (drainerTimer != null) return;
  startedAt = Date.now();
  drainerTimer = setInterval(() => {
    drainerTick().catch((e) => console.error("[drainer] uncaught:", e));
  }, DRAIN_INTERVAL_MS);

  console.info(`[drainer] Started — interval=${DRAIN_INTERVAL_MS}ms, batch=${BATCH_SIZE}`);
}

/**
 * Stop the drainer (e.g. during graceful shutdown).
 */
export function stopDrainer(): void {
  if (drainerTimer != null) {
    clearInterval(drainerTimer);
    drainerTimer = null;
    console.info("[drainer] Stopped");
  }
}

/**
 * Get drainer statistics.
 */
export function getDrainerStats(): DrainerStats {
  return {
    ...stats,
    uptimeMs: startedAt != null ? Date.now() - startedAt : 0,
  };
}

/**
 * Enqueue a transaction for background submission.
 * Returns the queue entry ID for status polling.
 */
export async function enqueueTransaction(opts: {
  accountId: string;
  contractId: string;
  method: string;
  args: unknown;
  maxAttempts?: number;
}): Promise<string> {
  const entry = await prisma.transactionQueue.create({
    data: {
      accountId: opts.accountId,
      contractId: opts.contractId,
      method: opts.method,
      args: opts.args as object,
      status: "pending",
      maxAttempts: opts.maxAttempts ?? MAX_ATTEMPTS,
    },
  });
  return entry.id;
}
