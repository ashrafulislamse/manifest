/**
 * Last-resort fallback catalog for AeroLink.
 *
 * AeroLink (https://aerolink.lat) DOES expose `/v1/models` on
 * `capi.aerolink.lat`, and that endpoint is the primary source of truth for
 * the model list — see `PROVIDER_CONFIGS.aerolink` in
 * `provider-model-fetcher.service.ts`. The fetcher calls the live endpoint
 * first; this module is consulted only when the live call fails (network
 * error, auth rejection, malformed response, or an empty `data` array).
 *
 * Pricing comes from the AeroLink docs / dashboard
 * (https://aerolink.lat/dashboard/api-keys) because the live `/v1/models`
 * endpoint does not publish pricing. If AeroLink adds a new model before
 * the docs catch up, add a row here with the published price.
 *
 * Pure data module: no @Injectable, no async I/O, no clock — so the
 * fallback can be called from any code path without setup.
 */

import type { DiscoveredModel } from './model-fetcher';

/** Anthropic-compatible context window shared by every AeroLink model. */
const AEROLINK_CONTEXT_WINDOW = 200_000;

/** Conversion factor: the docs quote USD per 1M tokens. */
const PER_MILLION = 1_000_000;

interface AeroLinkModelPrice {
  input: number;
  output: number;
}

/**
 * Model ID → per-million-token USD price published in the AeroLink docs.
 *
 * Source: https://aerolink.lat/docs (verified against the API key
 * dashboard at https://aerolink.lat/dashboard/api-keys at the time this
 * catalog was added). Update in lockstep with the docs.
 *
 * `qualityScore` is intentionally left at the package default of 3 for
 * every model — AeroLink does not publish its own quality ranking, and
 * the auto-tier-assigner uses this only as a hint when multiple models
 * are in the same price band.
 *
 * Exported (not private) so the live `/v1/models` parser can fill in
 * per-token prices for models the live response returns — the live
 * endpoint omits pricing, so the docs map is the only authoritative
 * source.
 */
export const AEROLINK_PRICES: Readonly<Record<string, AeroLinkModelPrice>> = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

/**
 * Build the canonical AeroLink model list as `DiscoveredModel` rows ready
 * to be persisted into `tenant_providers.cached_models`. Pure function —
 * no async I/O, no environment access, no clock — so it can be called
 * from tests and discovery paths alike without setup.
 */
export function buildAeroLinkModels(): DiscoveredModel[] {
  return Object.entries(AEROLINK_PRICES).map(([id, price]) => ({
    id,
    displayName: id,
    provider: 'aerolink',
    contextWindow: AEROLINK_CONTEXT_WINDOW,
    inputPricePerToken: price.input / PER_MILLION,
    outputPricePerToken: price.output / PER_MILLION,
    capabilityReasoning: false,
    capabilityCode: true,
    qualityScore: 3,
  }));
}
