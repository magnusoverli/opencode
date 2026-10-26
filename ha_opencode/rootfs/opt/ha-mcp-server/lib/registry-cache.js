/** Invalidation also prevents an older in-flight read from refilling the cache. */
export function createRegistryCache(load, { ttlMs = 300000, now = Date.now } = {}) {
  const entries = new Map();
  let generation = 0;
  return {
    async get(type) {
      const cached = entries.get(type);
      if (cached && now() - cached.fetchedAt < ttlMs) return cached.data;
      const startedAt = generation;
      const data = await load(type);
      if (startedAt === generation) entries.set(type, { data, fetchedAt: now() });
      return data;
    },
    delete(type) {
      generation++;
      entries.delete(type);
    },
    clear() {
      generation++;
      entries.clear();
    },
  };
}
