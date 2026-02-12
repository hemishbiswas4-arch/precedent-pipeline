type CacheEntry = {
  value: string;
  expiresAt: number | null;
};

const memoryStore = new Map<string, CacheEntry>();

function nowMs(): number {
  return Date.now();
}

function isExpired(entry: CacheEntry | undefined): boolean {
  if (!entry) return true;
  if (entry.expiresAt === null) return false;
  return entry.expiresAt <= nowMs();
}

function safeParseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseTtlSeconds(ttlSeconds: number | undefined): number | null {
  if (!Number.isFinite(ttlSeconds) || !ttlSeconds || ttlSeconds <= 0) {
    return null;
  }
  return Math.floor(ttlSeconds);
}

class SharedCache {
  private readonly restUrl = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";

  private readonly restToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";

  private get remoteEnabled(): boolean {
    return this.restUrl.length > 0 && this.restToken.length > 0;
  }

  private cleanupMemoryKey(key: string): void {
    const current = memoryStore.get(key);
    if (isExpired(current)) {
      memoryStore.delete(key);
    }
  }

  private async callRedis(command: string, args: string[]): Promise<unknown> {
    if (!this.remoteEnabled) {
      return null;
    }

    const path = [command, ...args].map((part) => encodeURIComponent(part)).join("/");
    const response = await fetch(`${this.restUrl}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.restToken}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`Shared cache HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { result?: unknown };
    return payload.result ?? null;
  }

  async getString(key: string): Promise<string | null> {
    if (this.remoteEnabled) {
      try {
        const result = await this.callRedis("GET", [key]);
        return typeof result === "string" ? result : null;
      } catch {
        // fall through to memory fallback
      }
    }

    this.cleanupMemoryKey(key);
    const entry = memoryStore.get(key);
    if (!entry) return null;
    return entry.value;
  }

  async setString(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const ttl = parseTtlSeconds(ttlSeconds);

    if (this.remoteEnabled) {
      try {
        const args = ttl ? [key, value, "EX", String(ttl)] : [key, value];
        await this.callRedis("SET", args);
      } catch {
        // fall back to memory
      }
    }

    memoryStore.set(key, {
      value,
      expiresAt: ttl ? nowMs() + ttl * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    if (this.remoteEnabled) {
      try {
        await this.callRedis("DEL", [key]);
      } catch {
        // continue with memory delete
      }
    }
    memoryStore.delete(key);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.getString(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.setString(key, JSON.stringify(value), ttlSeconds);
  }

  async acquireLock(key: string, owner: string, ttlSeconds: number): Promise<boolean> {
    const ttl = Math.max(1, Math.floor(ttlSeconds));

    if (this.remoteEnabled) {
      try {
        const result = await this.callRedis("SET", [key, owner, "NX", "EX", String(ttl)]);
        if (typeof result === "string") {
          return result.toUpperCase() === "OK";
        }
        if (result === null) {
          return false;
        }
        return Boolean(result);
      } catch {
        // fall back to memory lock
      }
    }

    this.cleanupMemoryKey(key);
    const current = memoryStore.get(key);
    if (current) {
      return false;
    }
    memoryStore.set(key, {
      value: owner,
      expiresAt: nowMs() + ttl * 1000,
    });
    return true;
  }

  async releaseLock(key: string, owner: string): Promise<void> {
    if (this.remoteEnabled) {
      try {
        const current = await this.callRedis("GET", [key]);
        if (current === owner) {
          await this.callRedis("DEL", [key]);
        }
      } catch {
        // continue with memory release
      }
    }

    this.cleanupMemoryKey(key);
    const local = memoryStore.get(key);
    if (local?.value === owner) {
      memoryStore.delete(key);
    }
  }

  async increment(key: string, ttlSeconds?: number): Promise<number> {
    const ttl = parseTtlSeconds(ttlSeconds);

    if (this.remoteEnabled) {
      try {
        const result = await this.callRedis("INCR", [key]);
        const incremented = safeParseNumber(result) ?? 0;
        if (ttl && incremented === 1) {
          await this.callRedis("EXPIRE", [key, String(ttl)]);
        }
        return incremented;
      } catch {
        // continue with memory fallback
      }
    }

    this.cleanupMemoryKey(key);
    const current = memoryStore.get(key);
    const nextValue = (safeParseNumber(current?.value) ?? 0) + 1;
    memoryStore.set(key, {
      value: String(nextValue),
      expiresAt: ttl ? nowMs() + ttl * 1000 : current?.expiresAt ?? null,
    });
    return nextValue;
  }
}

export const sharedCache = new SharedCache();
