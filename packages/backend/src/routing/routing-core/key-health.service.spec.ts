import type { Repository } from 'typeorm';
import type { TenantProvider } from '../../entities/tenant-provider.entity';
import type { RoutingCacheService } from './routing-cache.service';
import { KeyHealthService, ROTATION_TRIGGER_STATUSES } from './key-health.service';

/**
 * Coverage targets:
 *  - recordFailure increments `consecutive_failures`, sets `cooldown_until`
 *    using the exponential backoff table, and respects the trigger list.
 *  - recordFailure / recordSuccess invalidate the tenant-scoped provider-key
 *    cache so the next selectProviderKey call sees the new cooldown.
 *  - recordSuccess clears the streak and cooldown, but skips the UPDATE
 *    when the row is already in the healthy baseline (hot-path quiet).
 *  - computeCooldownMs is deterministic and clamps at 1h.
 *  - isKeyCoolingDown is a pure function over a `now` clock.
 *
 * The repo is mocked — `KeyHealthService` doesn't touch provider encryption,
 * pricing, or any other service, so the test stays focused.
 */
describe('KeyHealthService', () => {
  const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

  let repo: jest.Mocked<Repository<TenantProvider>>;
  let cache: jest.Mocked<Pick<RoutingCacheService, 'invalidateTenantProviderKeys'>>;
  let svc: KeyHealthService;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<Repository<TenantProvider>>;
    cache = {
      invalidateTenantProviderKeys: jest.fn(),
    };
    svc = new KeyHealthService(repo, cache as unknown as RoutingCacheService);
  });

  describe('computeCooldownMs', () => {
    it('returns 0 for non-positive failure counts', () => {
      expect(svc.computeCooldownMs(0)).toBe(0);
      expect(svc.computeCooldownMs(-1)).toBe(0);
    });

    it('doubles per consecutive failure, starting at 60s', () => {
      expect(svc.computeCooldownMs(1)).toBe(60_000);
      expect(svc.computeCooldownMs(2)).toBe(120_000);
      expect(svc.computeCooldownMs(3)).toBe(240_000);
      expect(svc.computeCooldownMs(4)).toBe(480_000);
      expect(svc.computeCooldownMs(5)).toBe(960_000);
    });

    it('clamps at one hour', () => {
      // 2^20 minutes ≈ 12 days — well past the 1h ceiling.
      expect(svc.computeCooldownMs(50)).toBe(60 * 60 * 1_000);
    });
  });

  describe('isKeyCoolingDown', () => {
    const rowOf = (iso: string | null): TenantProvider =>
      ({ cooldown_until: iso }) as unknown as TenantProvider;

    it('returns false when cooldown_until is null', () => {
      expect(svc.isKeyCoolingDown(rowOf(null), FIXED_NOW)).toBe(false);
    });

    it('returns true when cooldown_until is in the future', () => {
      expect(svc.isKeyCoolingDown(rowOf('2026-01-01T00:01:00.000Z'), FIXED_NOW)).toBe(true);
    });

    it('returns false when cooldown_until is in the past', () => {
      expect(svc.isKeyCoolingDown(rowOf('2025-12-31T23:59:00.000Z'), FIXED_NOW)).toBe(false);
    });

    it('treats the exact boundary as not cooling down', () => {
      // Now == cooldown_until → no longer cooling. Caller-side this matches
      // `cooldown_until > now` so the key becomes eligible at exactly T.
      expect(svc.isKeyCoolingDown(rowOf(FIXED_NOW.toISOString()), FIXED_NOW)).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('returns early when no tenantProviderId is supplied', async () => {
      await svc.recordFailure('', 429);
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('returns early for non-trigger statuses (e.g. 400, 404, 422)', async () => {
      await svc.recordFailure('up-1', 400);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('returns early when the row does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await svc.recordFailure('up-missing', 429);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it.each([
      [401, 1, 60_000],
      [403, 2, 120_000],
      [429, 3, 240_000],
      [500, 4, 480_000],
      [502, 5, 960_000],
      [503, 6, 1_920_000],
      [504, 50, 3_600_000],
    ])(
      'records failure for status %i with streak n=%i → cooldown=%ims',
      async (status, n, expected) => {
        const row: TenantProvider = {
          id: 'up-1',
          tenant_id: 'tenant-A',
          provider: 'openai',
          label: 'Default',
          consecutive_failures: n - 1,
          cooldown_until: null,
        } as unknown as TenantProvider;
        repo.findOne.mockResolvedValue(row);
        const before = Date.now();
        await svc.recordFailure('up-1', status);
        const after = Date.now();

        expect(repo.update).toHaveBeenCalledTimes(1);
        const [criteria, fields] = repo.update.mock.calls[0] as unknown as [
          { id: string },
          {
            last_failure_at: string;
            consecutive_failures: number;
            cooldown_until: string;
          },
        ];
        expect(criteria).toEqual({ id: 'up-1' });
        expect(fields.consecutive_failures).toBe(n);
        const cooldownMs = Date.parse(fields.cooldown_until) - Date.parse(fields.last_failure_at);
        // Two assertions: matches the expected formula, and the expiry sits
        // within the test window so `last_failure_at` and `cooldown_until`
        // are computed against the same wall clock. Allow 5ms of slack
        // because `recordFailure` samples Date.now() in two places, and
        // sub-millisecond drift can make the computed delta fall 1ms short.
        expect(cooldownMs).toBeGreaterThanOrEqual(expected - 5);
        expect(cooldownMs).toBeLessThanOrEqual(expected);
        expect(Date.parse(fields.last_failure_at)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(fields.last_failure_at)).toBeLessThanOrEqual(after);
        // Cache invalidation is the only thing that makes rotation actually
        // take effect on the next request — the 2-min TTL would otherwise
        // hide the new cooldown_until.
        expect(cache.invalidateTenantProviderKeys).toHaveBeenCalledWith('tenant-A');
      },
    );

    it('does NOT invalidate the cache for non-trigger statuses', async () => {
      await svc.recordFailure('up-1', 400);
      expect(cache.invalidateTenantProviderKeys).not.toHaveBeenCalled();
    });

    it('treats every status in ROTATION_TRIGGER_STATUSES as a trigger', () => {
      for (const status of ROTATION_TRIGGER_STATUSES) {
        expect([...ROTATION_TRIGGER_STATUSES]).toContain(status);
      }
      // Spot-check the canonical ones so a typo in the table fails loudly.
      expect(ROTATION_TRIGGER_STATUSES.has(401)).toBe(true);
      expect(ROTATION_TRIGGER_STATUSES.has(429)).toBe(true);
      expect(ROTATION_TRIGGER_STATUSES.has(500)).toBe(true);
      expect(ROTATION_TRIGGER_STATUSES.has(503)).toBe(true);
    });

    it('does NOT treat 400 / 404 / 422 as rotation triggers', () => {
      // Request-shape errors are not the key's fault; rotating would just
      // mask the upstream message with a different one.
      expect(ROTATION_TRIGGER_STATUSES.has(400)).toBe(false);
      expect(ROTATION_TRIGGER_STATUSES.has(404)).toBe(false);
      expect(ROTATION_TRIGGER_STATUSES.has(422)).toBe(false);
    });
  });

  describe('recordSuccess', () => {
    it('returns early when no tenantProviderId is supplied', async () => {
      await svc.recordSuccess('');
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('returns early when the row does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await svc.recordSuccess('up-missing');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('skips the UPDATE when the row is already healthy (hot-path quiet)', async () => {
      repo.findOne.mockResolvedValue({
        id: 'up-1',
        provider: 'openai',
        label: 'Default',
        consecutive_failures: 0,
        cooldown_until: null,
        last_failure_at: null,
      } as unknown as TenantProvider);
      await svc.recordSuccess('up-1');
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('clears cooldown / streak / last_failure_at on recovery', async () => {
      repo.findOne.mockResolvedValue({
        id: 'up-1',
        tenant_id: 'tenant-A',
        provider: 'openai',
        label: 'Default',
        consecutive_failures: 3,
        cooldown_until: '2026-01-01T01:00:00.000Z',
        last_failure_at: '2025-12-31T23:55:00.000Z',
      } as unknown as TenantProvider);
      await svc.recordSuccess('up-1');

      expect(repo.update).toHaveBeenCalledWith(
        { id: 'up-1' },
        { last_failure_at: null, consecutive_failures: 0, cooldown_until: null },
      );
      expect(cache.invalidateTenantProviderKeys).toHaveBeenCalledWith('tenant-A');
    });

    it('does NOT invalidate the cache when the row is already healthy', async () => {
      repo.findOne.mockResolvedValue({
        id: 'up-1',
        tenant_id: 'tenant-A',
        provider: 'openai',
        label: 'Default',
        consecutive_failures: 0,
        cooldown_until: null,
        last_failure_at: null,
      } as unknown as TenantProvider);
      await svc.recordSuccess('up-1');
      expect(cache.invalidateTenantProviderKeys).not.toHaveBeenCalled();
    });

    it('reset() is an alias for recordSuccess', async () => {
      const spy = jest.spyOn(svc, 'recordSuccess').mockResolvedValue();
      await svc.reset('up-1');
      expect(spy).toHaveBeenCalledWith('up-1');
    });
  });
});
