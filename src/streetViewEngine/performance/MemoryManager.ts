import type { ProviderPolicy } from '../types';

export interface DisposableResource {
  dispose?: () => void;
}

/**
 * Bounded LRU memory manager for decoded panorama frames / GPU textures.
 * When `policy.allowPersistentImageCache` is false (e.g. Google Street View),
 * maxEntries is forced to 0 so imagery is NEVER cached beyond active Buffer A / Buffer B.
 */
export class MemoryManager<T extends DisposableResource> {
  private readonly maxEntries: number;
  private readonly cache = new Map<string, T>();

  constructor(policy: ProviderPolicy, licensedMaxEntries = 12) {
    this.maxEntries = policy.allowPersistentImageCache
      ? Math.max(1, licensedMaxEntries)
      : 0;
  }

  public isCachingEnabled(): boolean {
    return this.maxEntries > 0;
  }

  public get(key: string): T | null {
    if (this.maxEntries === 0) return null;
    const found = this.cache.get(key);
    if (!found) return null;
    // Promote LRU
    this.cache.delete(key);
    this.cache.set(key, found);
    return found;
  }

  public set(key: string, resource: T): void {
    if (this.maxEntries === 0) {
      resource.dispose?.();
      return;
    }

    const existing = this.cache.get(key);
    if (existing && existing !== resource) {
      existing.dispose?.();
      this.cache.delete(key);
    }

    this.cache.set(key, resource);
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const oldestVal = this.cache.get(oldestKey);
      this.cache.delete(oldestKey);
      oldestVal?.dispose?.();
    }
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    for (const resource of this.cache.values()) {
      resource.dispose?.();
    }
    this.cache.clear();
  }
}
