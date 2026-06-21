import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantProvider } from '../../entities/tenant-provider.entity';
import { RoutingCacheService } from './routing-cache.service';

/**
 * Outcomes from `tryForwardToProvider` that should mark the key as failing.
 *
 * `4xx` outside of 408/429 (e.g. 401 invalid key, 403 scope revoked) and 5xx
 * server errors are both treated as "the key is exhausted / broken right
 * now". 4xx validation errors (400) and 404 (model not found) are NOT in
 * this set — they reflect a request-side problem and a different key won't
 * help, so rotating would just hide the bug.
 */
export const ROTATION_TRIGGER_STATUSES = new Set<number>([
  401, 403, 408, 409, 429, 500, 502, 503, 504,
]);

/** Base cooldown for the first failure, in milliseconds. */
const COOLDOWN_BASE_MS = 60_000;

/** Cooldown ceiling — even after many consecutive failures we never wait longer than this. */
const COOLDOWN_MAX_MS = 60 * 60 * 1_000; // 1h

/**
 * Per-key cooldown tracking for rate-limit-aware API key rotation.
 *
 * Some upstream LLM providers cap usage per key on a fixed window (e.g.
 * AeroLink's $10 / 4h limit). Once a key is exhausted, every subsequent
 * request returns 429 until the window resets — so Manifest needs to know
 * which keys are currently usable.
 *
 * The hot path is `selectProviderKey` in `ProviderKeyService`, which now
 * skips keys whose `cooldown_until > NOW()`. To keep that cheap, this
 * service only writes to `tenant_providers` (no separate table) and only
 * bumps `cooldown_until` forward when a key actually misbehaves.
 *
 * Failure backoff is exponential: `COOLDOWN_BASE_MS * 2^(failures - 1)`,
 * clamped at `COOLDOWN_MAX_MS`. One success fully resets the streak — keys
 * that recover are immediately eligible again, no waiting for the counter
 * to decay. The cooldown duration is short enough that an accidental 401
 * (e.g. a freshly-revoked key) recovers within minutes, but long enough
 * that a sustained 429 storm can't burn through every key in seconds.
 */
@Injectable()
export class KeyHealthService {
  private readonly logger = new Logger(KeyHealthService.name);

  constructor(
    @InjectRepository(TenantProvider)
    private readonly providerRepo: Repository<TenantProvider>,
    private readonly routingCache: RoutingCacheService,
  ) {}

  /**
   * Marks the given key as having failed. Computes the next cooldown from
   * the freshly incremented `consecutive_failures` count and persists both
   * fields in a single UPDATE. Idempotent: a row that already reflects the
   * new state is left untouched (matching consecutive count + a later
   * cooldown_until) so this is safe to call from the proxy retry path
   * without worrying about double-counting.
   *
   * Side effect: invalidates the tenant-scoped provider-key cache so the
   * very next `selectProviderKey` call sees the new `cooldown_until`. Without
   * this, the 2-minute TTL on `RoutingCacheService.providerKeys` would keep
   * the stale `cooldownUntil: null` snapshot for up to two minutes and the
   * proxy would keep hammering the same failed key.
   */
  async recordFailure(tenantProviderId: string, status: number): Promise<void> {
    if (!tenantProviderId) return;
    if (!ROTATION_TRIGGER_STATUSES.has(status)) return;

    const row = await this.providerRepo.findOne({ where: { id: tenantProviderId } });
    if (!row) {
      this.logger.warn(`recordFailure: tenantProvider ${tenantProviderId} not found`);
      return;
    }

    const nextFailures = row.consecutive_failures + 1;
    const cooldownMs = this.computeCooldownMs(nextFailures);
    const cooldownUntilIso = new Date(Date.now() + cooldownMs).toISOString();
    const nowIso = new Date().toISOString();

    await this.providerRepo.update(
      { id: tenantProviderId },
      {
        last_failure_at: nowIso,
        consecutive_failures: nextFailures,
        cooldown_until: cooldownUntilIso,
      },
    );
    this.routingCache.invalidateTenantProviderKeys(row.tenant_id);

    this.logger.debug(
      `key ${tenantProviderId} (${row.provider}/${row.label}) failed ` +
        `status=${status} streak=${nextFailures} cooldown=${cooldownMs}ms ` +
        `until=${cooldownUntilIso}`,
    );
  }

  /**
   * Clears the cooldown state on a successful forward. A single 2xx is
   * enough to fully reset the streak — keys that come back online should
   * not have to wait for the counter to decay.
   *
   * Side effect: invalidates the tenant-scoped provider-key cache when an
   * actual change is made so subsequent `selectProviderKey` calls see the
   * cleared `cooldown_until`. Skipped on no-op writes to keep the hot
   * path quiet.
   */
  async recordSuccess(tenantProviderId: string): Promise<void> {
    if (!tenantProviderId) return;

    const row = await this.providerRepo.findOne({ where: { id: tenantProviderId } });
    if (!row) {
      this.logger.warn(`recordSuccess: tenantProvider ${tenantProviderId} not found`);
      return;
    }

    // Skip the UPDATE when the row is already in the "healthy" baseline —
    // keeps the hot path quiet when keys are mostly working.
    if (
      row.consecutive_failures === 0 &&
      row.cooldown_until === null &&
      row.last_failure_at === null
    ) {
      return;
    }

    await this.providerRepo.update(
      { id: tenantProviderId },
      {
        last_failure_at: null,
        consecutive_failures: 0,
        cooldown_until: null,
      },
    );
    this.routingCache.invalidateTenantProviderKeys(row.tenant_id);

    this.logger.debug(`key ${tenantProviderId} (${row.provider}/${row.label}) recovered`);
  }

  /**
   * Manual reset hook for ops / UI "reset key" actions. Exposed separately
   * so the proxy path stays the only writer of the streak counters.
   */
  async reset(tenantProviderId: string): Promise<void> {
    await this.recordSuccess(tenantProviderId);
  }

  /**
   * Returns the cooldown (ms) for the Nth consecutive failure: 60s, 120s,
   * 240s, ... capped at 1h. Exported (not private) so the unit tests can
   * assert the table directly without re-implementing the math.
   */
  computeCooldownMs(consecutiveFailures: number): number {
    if (consecutiveFailures <= 0) return 0;
    const exponent = Math.min(consecutiveFailures - 1, 20);
    return Math.min(COOLDOWN_BASE_MS * 2 ** exponent, COOLDOWN_MAX_MS);
  }

  /**
   * Returns true when the given key's cooldown is still in the future.
   * Pure function over the row — no DB hit. Caller is responsible for
   * supplying a `now` so tests can drive a deterministic clock.
   */
  isKeyCoolingDown(row: TenantProvider, now: Date = new Date()): boolean {
    if (!row.cooldown_until) return false;
    return new Date(row.cooldown_until).getTime() > now.getTime();
  }
}
