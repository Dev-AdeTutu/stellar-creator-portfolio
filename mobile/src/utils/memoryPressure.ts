/**
 * Memory Optimization — Issue #835 (enhanced)
 *
 * Integrates with:
 *  - ImageLRUCache (50 MB cap, LRU eviction)
 *  - TelemetryCollector (memory pressure events logged)
 *  - AppState (background → flush cache)
 *
 * Pressure thresholds (matching native iOS/Android low-memory callbacks):
 *  LOW      → purge 50% of image cache
 *  CRITICAL → purge all cached images + pause WS connection
 *
 * Usage:
 *   startMemoryPressureMonitor();
 *   // On app background:
 *   onBackground(() => flushAllCaches());
 */

import { AppState, AppStateStatus, NativeModules, Platform } from 'react-native';
import { imageCache } from '../cache/ImageLRUCache';
import { telemetry } from '../telemetry/TelemetryCollector';

// Re-export original utilities so existing imports aren't broken
export { ItemMemoryCache, BatchCleanupProcessor, MemoryMonitor } from './memoryOptimizationBase';

export type MemoryPressureLevel = 'normal' | 'low' | 'critical';

export interface MemoryPressureEvent {
  level: MemoryPressureLevel;
  /** Estimated JS heap used in MB (best-effort) */
  usedMB: number;
  timestamp: number;
}

type PressureListener = (event: MemoryPressureEvent) => void;

// ── Pressure detection ─────────────────────────────────────────────────────────

/** Best-effort JS heap size in MB */
function getJSHeapMB(): number {
  const g = global as any;
  if (typeof g.__hermesMemoryInfo === 'function') {
    const info = g.__hermesMemoryInfo();
    return (info.used ?? 0) / (1024 * 1024);
  }
  if (g.performance?.memory) {
    return g.performance.memory.usedJSHeapSize / (1024 * 1024);
  }
  return 0;
}

// Thresholds in MB for JS heap
const LOW_MEMORY_MB = 150;      // Warn at 150 MB
const CRITICAL_MEMORY_MB = 180; // Critical at 180 MB (< 200 MB target)

function detectPressureLevel(usedMB: number): MemoryPressureLevel {
  if (usedMB >= CRITICAL_MEMORY_MB) return 'critical';
  if (usedMB >= LOW_MEMORY_MB) return 'low';
  return 'normal';
}

// ── Monitor state ──────────────────────────────────────────────────────────────

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastPressureLevel: MemoryPressureLevel = 'normal';
const pressureListeners = new Set<PressureListener>();
let wsConnectionRef: { pause?: () => void; resume?: () => void } | null = null;
let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

/**
 * React to memory pressure by purging cache and notifying listeners.
 */
function handlePressure(level: MemoryPressureLevel, usedMB: number): void {
  const event: MemoryPressureEvent = { level, usedMB, timestamp: Date.now() };

  if (level === 'low' && lastPressureLevel !== 'low') {
    console.warn(`[memory] LOW pressure (${usedMB.toFixed(1)} MB) — purging 50% image cache`);
    const evicted = imageCache.purgePercent(50);
    console.info(`[memory] Purged ${evicted} image cache entries`);
  }

  if (level === 'critical' && lastPressureLevel !== 'critical') {
    console.error(`[memory] CRITICAL pressure (${usedMB.toFixed(1)} MB) — flushing all caches`);
    imageCache.flush();
    // Pause WebSocket to free up buffers
    wsConnectionRef?.pause?.();
    console.warn('[memory] WebSocket connection paused');
  }

  if (level === 'normal' && lastPressureLevel !== 'normal') {
    // Recovering — resume WS if it was paused
    wsConnectionRef?.resume?.();
    console.info('[memory] Pressure normalised — WebSocket resumed');
  }

  // Log to telemetry
  telemetry.captureMemorySnapshot();
  pressureListeners.forEach((l) => {
    try { l(event); } catch { /* isolated */ }
  });

  lastPressureLevel = level;
}

/**
 * Start periodic memory pressure monitoring.
 * Safe to call multiple times (idempotent).
 *
 * @param intervalMs  Poll interval (default 5 000 ms)
 */
export function startMemoryPressureMonitor(intervalMs = 5_000): void {
  if (monitorTimer != null) return;

  // 1. Periodic JS-heap check
  monitorTimer = setInterval(() => {
    const usedMB = getJSHeapMB();
    const level = detectPressureLevel(usedMB);
    if (level !== lastPressureLevel) {
      handlePressure(level, usedMB);
    }
  }, intervalMs);

  // 2. AppState: flush on background, resume on foreground
  appStateSubscription = AppState.addEventListener(
    'change',
    (nextState: AppStateStatus) => {
      if (nextState === 'background') {
        console.info('[memory] App backgrounded — flushing image cache');
        imageCache.flush();
      }
    },
  );

  // 3. Native low-memory warning (iOS / Android)
  if (
    Platform.OS === 'ios' &&
    NativeModules.MemoryWarning?.addListener
  ) {
    // Expo / bare: native module emits 'memoryWarning'
    NativeModules.MemoryWarning.addListener('memoryWarning', () => {
      handlePressure('low', getJSHeapMB());
    });
  }

  console.info(`[memory] Monitor started (interval=${intervalMs}ms)`);
}

export function stopMemoryPressureMonitor(): void {
  if (monitorTimer != null) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  appStateSubscription?.remove();
  appStateSubscription = null;
  console.info('[memory] Monitor stopped');
}

/**
 * Register the active WebSocket connection so the monitor can pause it
 * under critical memory pressure.
 */
export function registerWSConnection(conn: {
  pause?: () => void;
  resume?: () => void;
}): void {
  wsConnectionRef = conn;
}

/** Subscribe to pressure-level changes */
export function onMemoryPressure(listener: PressureListener): () => void {
  pressureListeners.add(listener);
  return () => pressureListeners.delete(listener);
}

/**
 * Manually signal a pressure level — useful for testing or
 * bridging a native module's callback.
 */
export function signalMemoryPressure(level: MemoryPressureLevel): void {
  handlePressure(level, getJSHeapMB());
}

/** Flush all caches immediately (call from background task or low-memory handler) */
export function flushAllCaches(): void {
  imageCache.flush();
  telemetry.captureMemorySnapshot();
}

/** Current cache statistics */
export function getMemoryStats() {
  return {
    imageCache: imageCache.stats,
    pressureLevel: lastPressureLevel,
    heapMB: getJSHeapMB(),
  };
}
