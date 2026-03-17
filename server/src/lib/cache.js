// Simple in-memory TTL cache
class Cache {
  constructor(ttlMs = 90000) { // default 90 seconds
    this.store = new Map();
    this.ttlMs = ttlMs;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(pattern) {
    // Delete all keys that start with the given pattern
    for (const key of this.store.keys()) {
      if (key.startsWith(pattern)) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
  }
}

const availabilityCache = new Cache(90000); // 90s TTL

module.exports = { Cache, availabilityCache };
