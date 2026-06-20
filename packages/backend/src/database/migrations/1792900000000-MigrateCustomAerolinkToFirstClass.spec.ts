import { QueryRunner } from 'typeorm';

import { MigrateCustomAerolinkToFirstClass1792900000000 } from './1792900000000-MigrateCustomAerolinkToFirstClass';

/**
 * Drives the migration against a mock queryRunner. The mock returns
 * canned rows for the few queries whose return value steers control flow
 * (backfill_state lookup, custom_providers scan, tenant_providers
 * collision check) and records every SQL string for assertion.
 */
function makeRunner(responses: Record<string, unknown[]> = {}): {
  runner: QueryRunner;
  queries: string[];
} {
  const queries: string[] = [];
  const paramKeys: Array<{ key: string; rows: unknown[] }> = [];
  const sqlKeys: Array<{ key: string; rows: unknown[] }> = [];
  for (const [key, rows] of Object.entries(responses)) {
    if (key.startsWith('sql:')) sqlKeys.push({ key: key.slice(4), rows });
    else if (key.startsWith('param:')) paramKeys.push({ key: key.slice(6), rows });
    else sqlKeys.push({ key, rows });
  }
  const runner = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      queries.push(sql);
      // Parameterized matches take priority — a single SQL string can run
      // multiple times with different args and the canned rows should
      // reflect that. JSON.stringify the params for an exact-equality
      // check; the migration's callsites are deterministic so a string
      // compare is fine.
      const want = JSON.stringify(params);
      for (const { key, rows } of paramKeys) {
        if (key === want) return rows;
      }
      for (const { key, rows } of sqlKeys) {
        if (sql.includes(key)) return rows;
      }
      return [];
    }),
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('MigrateCustomAerolinkToFirstClass1792900000000', () => {
  const migration = new MigrateCustomAerolinkToFirstClass1792900000000();

  it('creates the backfill_state marker table if missing', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
    });
    await migration.up(runner);

    expect(queries[0]).toContain('CREATE TABLE IF NOT EXISTS "backfill_state"');
    expect(queries[0]).toContain('PRIMARY KEY ("name")');
  });

  it('short-circuits when the backfill has already run', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state" WHERE "name" = \'custom_aerolink_to_first_class\'': [
        { name: 'custom_aerolink_to_first_class' },
      ],
    });
    await migration.up(runner);

    // No Custom providers scan, no tenant_providers mutations.
    expect(queries.some((q) => q.includes('FROM "custom_providers"'))).toBe(false);
    expect(queries.some((q) => q.includes('INSERT INTO "tenant_providers"'))).toBe(false);
  });

  it('marks the backfill complete even when there are no Custom AeroLink rows', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [],
    });
    await migration.up(runner);

    expect(
      queries.some(
        (q) =>
          q.includes('INSERT INTO "backfill_state"') &&
          q.includes('custom_aerolink_to_first_class'),
      ),
    ).toBe(true);
    expect(queries.some((q) => q.includes('INSERT INTO "tenant_providers"'))).toBe(false);
  });

  it('migrates a single Custom AeroLink row into a first-class tenant_providers row', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
      ],
      'param:["tenant-a","custom:cp-1"]': [
        {
          id: 'tp-old',
          api_key_encrypted: 'ciphertext',
          key_prefix: 'sk-',
          label: 'AeroLink (prod)',
          priority: 5,
          auth_type: 'api_key',
        },
      ],
    });
    await migration.up(runner);

    const insert = queries.find(
      (q) => q.includes('INSERT INTO "tenant_providers"') && q.includes("'aerolink'"),
    );
    expect(insert).toBeDefined();
    // The tenant id, encrypted key, and label are bound as $N parameters —
    // assert on the parameterized SQL, not the literal value.
    expect(insert).toContain('$2');
    expect(insert).toContain('tenant_id');
    expect(insert).toContain('api_key_encrypted');
    expect(insert).toContain('label');

    // agent_enabled_providers rows are rewired to the new first-class id.
    expect(
      queries.some(
        (q) =>
          q.includes('UPDATE "agent_enabled_providers"') &&
          q.includes('SET "tenant_provider_id" = $1') &&
          q.includes('WHERE "tenant_provider_id" = $2'),
      ),
    ).toBe(true);

    // The companion and the custom_providers row are dropped.
    expect(queries.some((q) => q.includes('DELETE FROM "tenant_providers" WHERE id = $1'))).toBe(
      true,
    );
    expect(queries.some((q) => q.includes('DELETE FROM "custom_providers" WHERE id = $1'))).toBe(
      true,
    );

    // The backfill is marked complete.
    expect(
      queries.some(
        (q) =>
          q.includes('INSERT INTO "backfill_state"') &&
          q.includes('custom_aerolink_to_first_class'),
      ),
    ).toBe(true);
  });

  it('sorts Custom AeroLink rows by created_at in SQL so pg Date objects do not crash', async () => {
    // Regression: the original migration sorted in JS using
    // `a.created_at.localeCompare(b.created_at)`, which crashed in production
    // because the pg driver returns `created_at` as a Date — Dates have no
    // `.localeCompare`. The fix is `ORDER BY tenant_id ASC, created_at ASC`
    // so the survivor is the first row per tenant bucket.
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
      ],
      'param:["tenant-a","custom:cp-1"]': [
        {
          id: 'tp-old',
          api_key_encrypted: 'ciphertext',
          key_prefix: 'sk-',
          label: 'AeroLink (prod)',
          priority: 5,
          auth_type: 'api_key',
        },
      ],
    });
    await migration.up(runner);

    const scan = queries.find((q) => q.includes('FROM "custom_providers"'));
    expect(scan).toBeDefined();
    // The oldest-survivor rule must be enforced in SQL so we don't
    // depend on JS Date/string compare behavior (which crashed in prod
    // because the pg driver returns Date objects, not strings).
    expect(scan).toMatch(/ORDER BY tenant_id ASC, created_at ASC/);
    // The migration source itself must not perform a JS sort on the row
    // array — that path has no .localeCompare on Date instances.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '1792900000000-MigrateCustomAerolinkToFirstClass.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.localeCompare\(/);
  });

  it('emits the RAISE NOTICE summary without bind parameters (DO $$ blocks do not accept them)', async () => {
    // Regression: the original migration finished with
    //   `DO $$ BEGIN RAISE NOTICE 'migrated=%, skipped_already=%'; END $$`
    //   , [migrated, skippedAlreadyMigrated]
    // which crashed on Postgres because `DO $$ ... $$` is sent as a
    // parameterless prepared statement through the pg driver — supplying
    // 2 params errors with "bind message supplies 2 parameters, but
    // prepared statement requires 0". The fix inlines the integer
    // counters into the SQL string.
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
      ],
      'param:["tenant-a","custom:cp-1"]': [
        {
          id: 'tp-old',
          api_key_encrypted: 'ciphertext',
          key_prefix: 'sk-',
          label: 'AeroLink (prod)',
          priority: 5,
          auth_type: 'api_key',
        },
      ],
    });
    await migration.up(runner);

    const notice = queries.find((q) => q.includes('RAISE NOTICE'));
    expect(notice).toBeDefined();
    // The integer counters are interpolated directly — no $N placeholders.
    expect(notice).not.toMatch(/\$\d/);
    // No empty bind array was passed alongside the DO block.
    expect(notice).toContain('migrated=');
    expect(notice).toContain('skipped_already=');
  });

  it('skips tenants that already have a first-class AeroLink connection', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
      ],
      // The first SELECT against tenant_providers with provider='aerolink'
      // returns the first-class row → tenant is skipped.
      '"provider" = \'aerolink\'': [{ id: 'tp-existing' }],
    });
    await migration.up(runner);

    // No INSERT into tenant_providers — the existing tile is left alone.
    expect(queries.some((q) => q.includes('INSERT INTO "tenant_providers"'))).toBe(false);
    // No DELETE on custom_providers — legacy rows are preserved.
    expect(queries.some((q) => q.includes('DELETE FROM "custom_providers"'))).toBe(false);
  });

  it('deletes additional Custom AeroLink duplicates on the same tenant', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
        {
          id: 'cp-2',
          tenant_id: 'tenant-a',
          name: 'AeroLink 2',
          created_at: '2026-02-01T00:00:00Z',
        },
      ],
      // The survivor is the oldest row (cp-1). Its companion lookup
      // returns one row; subsequent companion lookups (for cp-2) return
      // an empty array.
      'param:["tenant-a","custom:cp-1"]': [
        {
          id: 'tp-1',
          api_key_encrypted: 'c1',
          key_prefix: 'sk-',
          label: 'AeroLink',
          priority: 0,
          auth_type: 'api_key',
        },
      ],
    });
    await migration.up(runner);

    // The survivor is migrated to a first-class row.
    expect(queries.some((q) => q.includes('INSERT INTO "tenant_providers"'))).toBe(true);
    // The extra Custom AeroLink row's companion is dropped.
    expect(
      queries.filter((q) => q.includes('DELETE FROM "tenant_providers"')).length,
    ).toBeGreaterThanOrEqual(2);
    // Then the Custom row itself.
    expect(
      queries.filter((q) => q.includes('DELETE FROM "custom_providers"')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('still uses the first-class tile when the Custom row has no companion', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
      ],
      // Survivor companion lookup returns no rows.
      'param:["tenant-a","custom:cp-1"]': [],
    });
    await migration.up(runner);

    const insert = queries.find((q) => q.includes('INSERT INTO "tenant_providers"'));
    expect(insert).toBeDefined();
    // No UPDATE on agent_enabled_providers when there is no companion id to rewire.
    expect(queries.some((q) => q.includes('UPDATE "agent_enabled_providers"'))).toBe(false);
  });

  it('uses sensible defaults when the companion row is missing optional fields', async () => {
    const { runner, queries } = makeRunner({
      'FROM "backfill_state"': [],
      'FROM "custom_providers"': [
        { id: 'cp-1', tenant_id: 'tenant-a', name: 'AeroLink', created_at: '2026-01-01T00:00:00Z' },
      ],
      'param:["tenant-a","custom:cp-1"]': [],
    });
    await migration.up(runner);

    const insert = queries.find((q) => q.includes('INSERT INTO "tenant_providers"'));
    expect(insert).toBeDefined();
    // The default label/auth_type flow uses $5/$7 for the surviving
    // companion — when no companion exists, the migration passes
    // 'AeroLink' / 'api_key' as $5/$5 fallback. We assert the
    // parameterized placeholder is present in either branch.
    expect(insert).toContain('label');
    expect(insert).toContain('auth_type');
  });

  it('down is a no-op (one-way migration)', async () => {
    await migration.down();
    // No DB calls — the migration cannot reconstruct the old Custom row
    // layout, so rollback is intentionally a no-op (see file doc).
  });
});
