import { QueryRunner } from 'typeorm';

import { AddTenantProviderKeyHealth1793000000000 } from './1793000000000-AddTenantProviderKeyHealth';

/**
 * Drives the migration against a mock queryRunner that records every SQL
 * string for assertion. The migration is pure DDL — no parameter binding —
 * so this test only has to confirm the right ALTER / CREATE INDEX statements
 * are emitted (in order) and that the inverse `down()` undoes them in
 * reverse order. Idempotency (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX
 * IF NOT EXISTS`) is baked into the SQL itself.
 */
function makeRunner(): { runner: QueryRunner; queries: string[] } {
  const queries: string[] = [];
  const runner = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return [];
    }),
  } as unknown as QueryRunner;
  return { runner, queries };
}

describe('AddTenantProviderKeyHealth1793000000000', () => {
  const migration = new AddTenantProviderKeyHealth1793000000000();

  it('adds the three cooldown columns and the partial index on up()', async () => {
    const { runner, queries } = makeRunner();
    await migration.up(runner);

    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain('ALTER TABLE "tenant_providers"');
    expect(queries[0]).toContain('ADD COLUMN IF NOT EXISTS "last_failure_at"');
    expect(queries[1]).toContain('ADD COLUMN IF NOT EXISTS "consecutive_failures"');
    expect(queries[1]).toContain('INTEGER NOT NULL DEFAULT 0');
    expect(queries[2]).toContain('ADD COLUMN IF NOT EXISTS "cooldown_until"');
    expect(queries[3]).toContain(
      'CREATE INDEX IF NOT EXISTS "idx_tenant_providers_cooldown_until"',
    );
    expect(queries[3]).toContain('"cooldown_until"');
    // Partial index — only rows that currently have a cooldown live in it.
    expect(queries[3]).toContain('WHERE "cooldown_until" IS NOT NULL');
  });

  it('drops the index and columns in reverse order on down()', async () => {
    const { runner, queries } = makeRunner();
    await migration.down(runner);

    expect(queries).toHaveLength(4);
    expect(queries[0]).toContain('DROP INDEX IF EXISTS "idx_tenant_providers_cooldown_until"');
    expect(queries[1]).toContain('DROP COLUMN IF EXISTS "cooldown_until"');
    expect(queries[2]).toContain('DROP COLUMN IF EXISTS "consecutive_failures"');
    expect(queries[3]).toContain('DROP COLUMN IF EXISTS "last_failure_at"');
  });

  it('uses IF NOT EXISTS / IF EXISTS guards so a partial run is safe', async () => {
    const { runner, queries } = makeRunner();
    await migration.up(runner);
    await migration.down(runner);

    const upDDL = queries.slice(0, 4);
    expect(upDDL.every((sql) => sql.includes('IF NOT EXISTS'))).toBe(true);
    const downDDL = queries.slice(4);
    expect(downDDL.every((sql) => sql.includes('IF EXISTS'))).toBe(true);
  });
});
