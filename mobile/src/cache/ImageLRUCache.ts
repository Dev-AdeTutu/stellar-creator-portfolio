/**
 * Image LRU Cache — Issue #835
 *
 * Memory-bounded LRU cache for portfolio images.
 * - Hard cap at 50 MB (configurable)
 * - On low-memory warning: purge 50% (LRU first)
 * - On critical memory: purge all
 * - Integrates with TelemetryCollector for memory pressure events
 */

import { telemetry } from '../telemetry/TelemetryCollector';

export interface CacheEntry {
  uri: string;
  sizeBytes: number;
  lastAccessed: number;
  width: number;
  height: number;
}

const MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB

class ImageLRUCache {
  private cache = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private maxBytes: number;

  constructor(maxBytes = MAX_CACHE_BYTES) {
    this.maxBytes = maxBytes;
  }

  set(key: string, entry: Omit<CacheEntry, 'lastAccessed'>): void {
    // Remove existing entry to update size accounting
    const existing = this.cache.get(key);
    if (existing) {
      this.totalBytes -= existing.sizeBytes;
      this.cache.delete(key);
    }

    this.cache.set(key, { ...entry, lastAccessed: Date.now() });
    this.totalBytes += entry.sizeBytes;

    // Evict LRU until under budget
    this.evictUntilUnder(this.maxBytes);
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (entry) {
      // Move to end (most recently used) — O(1) delete+set in V8 Map
      this.cache.delete(key);
      entry.lastAccessed = Date.now();
      this.cache.set(key, entry);
    }
    return entry;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Purge a percentage of the least-recently-used entries.
   * @param percent  0–100
   */
  purgePercent(percent: number): number {
    const targetEvictions = Math.ceil((this.cache.size * percent) / 100);
    const keys = Array.from(this.cache.keys()); // Ordered by insertion = LRU first
    let evicted = 0;

    for (let i = 0; i < targetEvictions && i < keys.length; i++) {
      const entry = this.cache.get(keys[i])!;
      this.totalBytes -= entry.sizeBytes;
      this.cache.delete(keys[i]);
      evicted++;
    }

    telemetry.captureMemorySnapshot();
    return evicted;
  }

  /** Flush entire cache (critical memory pressure) */
  flush(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.totalBytes = 0;
    console.warn(`[ImageCache] Critical: flushed ${count} entries`);
    telemetry.captureMemorySnapshot();
  }

  get stats() {
    return {
      entries: this.cache.size,
      totalMB: (this.totalBytes / (1024 * 1024)).toFixed(1),
      maxMB: (this.maxBytes / (1024 * 1024)).toFixed(1),
      utilizationPercent: Math.round((this.totalBytes / this.maxBytes) * 100),
    };
  }

  private evictUntilUnder(budget: number): void {
    const keys = Array.from(this.cache.keys());
    let i = 0;
    while (this.totalBytes > budget && i < keys.length) {
      const entry = this.cache.get(keys[i]);
      if (entry) {
        this.totalBytes -= entry.sizeBytes;
        this.cache.delete(keys[i]);
      }
      i++;
    }
  }
}

export const imageCache = new ImageLRUCache();
