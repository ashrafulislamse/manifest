import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time migration: collapse legacy Custom AeroLink entries into the new
 * first-class `aerolink` provider.
 *
 * Background
 * ----------
 * Before AeroLink became a first-class provider in SHARED_PROVIDERS, users
 * who wanted to route through `capi.aerolink.lat` had to register it as
 * one or more "Custom" provider tiles — one per agent, or one per auth
 * shape (OpenAI-compat / Anthropic-compat). The first-class provider
 * subsumes both auth kinds under a single tile, so the Custom duplicates
 * are now dead weight cluttering the routing grid and the Playground
 * model picker.
 *
 * What this does
 * --------------
 * For every tenant that has at least one Custom AeroLink row and no
 * first-class `aerolink` row yet:
 *   1. Pick the oldest Custom row (`created_at`) as the canonical survivor.
 *   2. Move its companion `tenant_providers` row's encrypted API key,
 *      label, priority, and auth_type forward to a new first-class
 *      `tenant_providers` row with `provider = 'aerolink'`. The
 *      ciphertext is reused as-is because the encryption helper derives
 *      its AES-256-GCM key from `MANIFEST_ENCRYPTION_KEY` (or
 *      `BETTER_AUTH_SECRET` as a fallback), neither of which is
 *      tenant-scoped — same key bytes decrypt cleanly from any row.
 *   3. Rewrite every `agent_enabled_providers` row that pointed at the
 *      Custom companion so it now enables the first-class one,
 *      preserving `enabled` and per-agent flags.
 *   4. Delete the Custom companion row and the Custom provider row.
 *   5. Delete any *additional* Custom AeroLink rows for the same tenant
 *      (and their companions) — they duplicated the same upstream and
 *      the user almost certainly wants them gone now that the
 *      first-class tile handles their use case.
 *
 * Idempotence
 * -----------
 * The whole rewrite is guarded by a `backfill_state` row named
 * `custom_aerolink_to_first_class`. Subsequent boots no-op.
 */
export class MigrateCustomAerolinkToFirstClass1792900000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // backfill_state was added by AddBackfillStateTable1792800000000.
    // CREATE TABLE IF NOT EXISTS lets us apply cleanly even on a fresh DB
    // where migrations ran out of order.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "backfill_state" (
         "name" varchar NOT NULL,
         "completed_at" timestamp NOT NULL DEFAULT NOW(),
         CONSTRAINT "PK_backfill_state" PRIMARY KEY ("name")
       )`,
    );

    const already: Array<{ name: string }> = await queryRunner.query(
      `SELECT "name" FROM "backfill_state" WHERE "name" = 'custom_aerolink_to_first_class'`,
    );
    if (already.length > 0) return;

    // Find every Custom AeroLink row: either its name matches the canonical
    // AeroLink display name (case-insensitive) or its base_url points at
    // AeroLink's API host. Both checks are necessary because users have
    // historically named these tiles "AeroLink" / "AeroLink-OpenAI-Compat" /
    // "claude via aerolink" / etc.
    //
    // Sorted by created_at ASC in SQL so the oldest row per tenant is at
    // the head of its bucket. This avoids relying on the driver returning
    // `created_at` as a Date/string (pg returns Date, which has no
    // .localeCompare) — see the runtime crash on the VPS deploy.
    const customAerolinkRows: Array<{
      id: string;
      tenant_id: string;
      name: string;
      created_at: Date | string;
    }> = await queryRunner.query(`
      SELECT id, tenant_id, name, created_at
        FROM "custom_providers"
       WHERE LOWER(name) IN ('aerolink', 'aerolinkanthropic', 'aerolinkopenai')
          OR "base_url" LIKE '%aerolink.lat%'
          OR "base_url" LIKE '%capi.aerolink%'
       ORDER BY tenant_id ASC, created_at ASC
    `);

    if (customAerolinkRows.length === 0) {
      // Nothing to do — still mark complete so we skip the SELECTs next boot.
      await queryRunner.query(
        `INSERT INTO "backfill_state" ("name") VALUES ('custom_aerolink_to_first_class')`,
      );
      return;
    }

    // Group by tenant_id. The list is already sorted by created_at within
    // each tenant (composite ORDER BY above), so rows[0] is the oldest.
    const byTenant = new Map<string, typeof customAerolinkRows>();
    for (const row of customAerolinkRows) {
      const list = byTenant.get(row.tenant_id) ?? [];
      list.push(row);
      byTenant.set(row.tenant_id, list);
    }

    let migrated = 0;
    let skippedAlreadyMigrated = 0;

    for (const [tenantId, rows] of byTenant) {
      // Skip tenants that already opted into the first-class AeroLink tile.
      // They may still have Custom leftovers (legitimate — e.g. they want to
      // keep a separate OpenAI-compat endpoint). Leave those untouched.
      const existingFirstClass: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM "tenant_providers"
          WHERE "tenant_id" = $1
            AND "provider" = 'aerolink'
          LIMIT 1`,
        [tenantId],
      );
      if (existingFirstClass.length > 0) {
        skippedAlreadyMigrated += rows.length;
        continue;
      }

      // The composite ORDER BY already sorted rows by created_at ASC per
      // tenant, so the survivor is simply the first one in the bucket.
      const survivor = rows[0]!;

      // Look up the survivor's companion tenant_providers row (the row that
      // stores the encrypted API key, label, etc.). Custom providers create
      // exactly one such companion on connect.
      const companionRows: Array<{
        id: string;
        api_key_encrypted: string | null;
        key_prefix: string | null;
        label: string;
        priority: number;
        auth_type: string;
      }> = await queryRunner.query(
        `SELECT id, api_key_encrypted, key_prefix, label, priority, auth_type
           FROM "tenant_providers"
          WHERE "tenant_id" = $1
            AND "provider" = $2
          LIMIT 1`,
        [tenantId, `custom:${survivor.id}`],
      );
      const companion = companionRows[0];
      const apiKeyEncrypted = companion?.api_key_encrypted ?? null;
      const keyPrefix = companion?.key_prefix ?? null;
      const label = companion?.label ?? 'AeroLink';
      const priority = companion?.priority ?? 0;
      const authType = companion?.auth_type ?? 'api_key';

      // Generate a fresh tenant_provider id. Deterministic prefix + tenant
      // + millis makes it greppable in logs; collisions are impossible
      // because `Date.now()` is monotonic within a single migration run.
      const newTenantProviderId = `tp_aerolink_${tenantId}_${Date.now().toString(36)}`;

      // Insert the new first-class tenant_providers row. The
      // `custom_provider_id` column is GENERATED and computed from
      // `provider LIKE 'custom:%'` — setting provider='aerolink' makes it
      // NULL automatically, which is what we want.
      await queryRunner.query(
        `INSERT INTO "tenant_providers"
           (id, tenant_id, created_by_user_id, agent_id, provider,
            api_key_encrypted, key_prefix, auth_type, label, priority,
            region, is_active, connected_at, updated_at)
         VALUES
           ($1, $2, NULL, NULL, 'aerolink',
            $3, $4, $5, $6, $7,
            NULL, TRUE, NOW(), NOW())`,
        [newTenantProviderId, tenantId, apiKeyEncrypted, keyPrefix, authType, label, priority],
      );

      // Rewrite every agent_enabled_providers row that pointed at the
      // survivor's companion so it now enables the first-class one.
      // Preserves `enabled` and any per-agent overrides.
      if (companion) {
        await queryRunner.query(
          `UPDATE "agent_enabled_providers"
              SET "tenant_provider_id" = $1
            WHERE "tenant_provider_id" = $2`,
          [newTenantProviderId, companion.id],
        );
        await queryRunner.query(`DELETE FROM "tenant_providers" WHERE id = $1`, [companion.id]);
      }

      // Delete the survivor's Custom provider row. The generated FK on
      // tenant_providers.custom_provider_id cascades, but we already
      // removed the companion above — this just removes the config row.
      await queryRunner.query(`DELETE FROM "custom_providers" WHERE id = $1`, [survivor.id]);

      // Delete any *other* Custom AeroLink rows for the same tenant — they
      // duplicated the same upstream and the user almost certainly wants
      // them gone now that the first-class tile handles the use case.
      const extraIds = rows.slice(1).map((r) => r.id);
      for (const extraId of extraIds) {
        await queryRunner.query(`DELETE FROM "tenant_providers" WHERE "provider" = $1`, [
          `custom:${extraId}`,
        ]);
        await queryRunner.query(`DELETE FROM "custom_providers" WHERE id = $1`, [extraId]);
      }

      migrated += rows.length;
    }

    await queryRunner.query(
      `INSERT INTO "backfill_state" ("name") VALUES ('custom_aerolink_to_first_class')`,
    );

    // The counters are local integers; inlining them is safe (no SQL
    // injection surface) and `DO $$ ... $$` blocks in Postgres do not
    // accept bind parameters through the pg driver's prepared-statement
    // path — supplying `[migrated, skippedAlreadyMigrated]` here crashes
    // with "bind message supplies N parameters, but prepared statement
    // requires 0".
    const summarySql = `DO $$ BEGIN RAISE NOTICE 'custom_aerolink_to_first_class: migrated=${migrated}, skipped_already=${skippedAlreadyMigrated}'; END $$`;
    await queryRunner.query(summarySql);
  }

  public async down(): Promise<void> {
    // Down-migration is intentionally a no-op. Reconstructing Custom
    // AeroLink rows from the first-class tile would require regenerating
    // UUIDs, re-encrypting the API key under a fresh `custom:` row, and
    // splitting `agent_enabled_providers` rows back to the old layout.
    // If you need to roll back, restore from a DB snapshot taken before
    // the migration ran.
  }
}
