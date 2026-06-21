import { Entity, Column, PrimaryColumn } from 'typeorm';
import type { AuthType } from 'manifest-shared';
import { timestampType, timestampDefault } from '../common/utils/postgres-sql';
import type { DiscoveredModel } from '../model-discovery/model-fetcher';

@Entity('tenant_providers')
export class TenantProvider {
  @PrimaryColumn('varchar')
  id!: string;

  @Column('varchar')
  tenant_id!: string;

  /** Audit-only: which user connected the provider. Never used for scoping. */
  @Column('varchar', { nullable: true, default: null })
  created_by_user_id!: string | null;

  @Column('varchar', { nullable: true, default: null })
  agent_id!: string | null;

  @Column('varchar')
  provider!: string;

  @Column('varchar', { nullable: true, default: null })
  api_key_encrypted!: string | null;

  @Column('varchar', { nullable: true, default: null })
  key_prefix!: string | null;

  @Column('varchar', { default: 'api_key' })
  auth_type!: AuthType;

  @Column('varchar', { default: 'Default' })
  label!: string;

  @Column('integer', { default: 0 })
  priority!: number;

  @Column('varchar', { nullable: true, default: null })
  region!: string | null;

  @Column('boolean', { default: true })
  is_active!: boolean;

  @Column(timestampType(), { default: timestampDefault() })
  connected_at!: string;

  @Column(timestampType(), { default: timestampDefault() })
  updated_at!: string;

  @Column('simple-json', { nullable: true, default: null })
  cached_models!: DiscoveredModel[] | null;

  @Column(timestampType(), { nullable: true, default: null })
  models_fetched_at!: string | null;

  /** Timestamp of the most recent upstream failure for this key. NULL = no failure observed. */
  @Column(timestampType(), { nullable: true, default: null })
  last_failure_at!: string | null;

  /** Consecutive upstream failure count. Reset to 0 on a successful forward. */
  @Column('integer', { default: 0 })
  consecutive_failures!: number;

  /**
   * Until when this key is excluded from `selectProviderKey`. NULL = immediately
   * eligible. Backed by `idx_tenant_providers_cooldown_until` for cheap filters.
   */
  @Column(timestampType(), { nullable: true, default: null })
  cooldown_until!: string | null;
}
