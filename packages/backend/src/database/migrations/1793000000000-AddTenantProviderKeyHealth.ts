import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-key cooldown tracking for rate-limit-aware key rotation.
 *
 * Some upstream LLM providers enforce a per-key request / cost budget that
 * resets on a fixed window (e.g. AeroLink's $10 / 4h limit). Manifest can
 * keep several keys attached and rotate to the next one when the active
 * key starts returning 429 / 401 / 5xx, but only if it can record and
 * observe each key's cooldown state.
 *
 * This migration adds three columns to `tenant_providers`:
 *
 *   `last_failure_at`        TIMESTAMP NULL
 *     Timestamp of the most recent upstream failure for this key. NULL
 *     means the key has never failed in this process's lifetime (or has
 *     recovered via `consecutive_failures` being reset to 0).
 *
 *   `consecutive_failures`   INTEGER NOT NULL DEFAULT 0
 *     Counts consecutive upstream failures. Reset to 0 on a successful
 *     forward. Drives the exponential-backoff multiplier used by
 *     KeyHealthService to compute `cooldown_until`.
 *
 *   `cooldown_until`         TIMESTAMP NULL
 *     Until when this key is excluded from `selectProviderKey`. NULL
 *     means the key is immediately eligible. Indexed so the selector can
 *     cheap-filter without scanning every key on hot paths.
 *
 * The columns are nullable / default 0 so the migration is a no-op for
 * existing rows: their cooldown state stays "eligible" (NULL) until the
 * first failure. The `up()` is idempotent (`ADD COLUMN IF NOT EXISTS`) so
 * a partial run followed by a retry is safe.
 *
 * The `idx_tenant_providers_cooldown_until` partial index covers the only
 * read pattern that matters for rotation: "find non-eligible keys for this
 * tenant" during cooldown cleanup or dashboard surfacing.
 */
export class AddTenantProviderKeyHealth1793000000000 implements MigrationInterface {
  name = 'AddTenantProviderKeyHealth1793000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" ADD COLUMN IF NOT EXISTS "last_failure_at" TIMESTAMP NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" ADD COLUMN IF NOT EXISTS "consecutive_failures" INTEGER NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" ADD COLUMN IF NOT EXISTS "cooldown_until" TIMESTAMP NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tenant_providers_cooldown_until" ` +
        `ON "tenant_providers" ("cooldown_until") WHERE "cooldown_until" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_tenant_providers_cooldown_until"`);
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" DROP COLUMN IF EXISTS "cooldown_until"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" DROP COLUMN IF EXISTS "consecutive_failures"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_providers" DROP COLUMN IF EXISTS "last_failure_at"`,
    );
  }
}
