import { DEFAULT_CONTEXT_WINDOW } from './model-fetcher';
import { buildAeroLinkModels } from './aerolink-models';

describe('buildAeroLinkModels (fallback catalog)', () => {
  // Live model discovery is the primary source — see the parser tests in
  // provider-model-fetcher.service.spec.ts. This module is only consulted
  // when the live /v1/models call fails (auth rejection, network error,
  // or empty `data` array). The contracts pinned below MUST stay in
  // sync with what the live parser produces so the user sees the same
  // row layout in either path.
  it('returns one DiscoveredModel row per priced model in the catalog', () => {
    // The catalog currently lists exactly six models. Update this count
    // (and the model-id assertion below) when adding a row to AEROLINK_PRICES.
    const models = buildAeroLinkModels();

    expect(models).toHaveLength(6);
  });

  it('uses "aerolink" as the provider on every row', () => {
    for (const model of buildAeroLinkModels()) {
      expect(model.provider).toBe('aerolink');
    }
  });

  it('keeps model id and display name in sync for every catalog row', () => {
    // AeroLink does not publish a separate display name; we surface the
    // model id verbatim so the UI shows the same string the user typed.
    const models = buildAeroLinkModels();

    for (const model of models) {
      expect(model.displayName).toBe(model.id);
    }
  });

  it('attaches the shared 200K Anthropic-compatible context window to every model', () => {
    for (const model of buildAeroLinkModels()) {
      expect(model.contextWindow).toBe(200_000);
    }
  });

  it('converts per-million USD pricing to per-token numbers', () => {
    // The catalog stores USD per 1M tokens (matching the docs). The
    // pipeline expects per-token numbers so token-recording math lines up
    // with how every other provider's pricing is consumed.
    const models = buildAeroLinkModels();
    const byId = new Map(models.map((m) => [m.id, m]));

    expect(byId.get('claude-opus-4-8')?.inputPricePerToken).toBeCloseTo(5 / 1_000_000);
    expect(byId.get('claude-opus-4-8')?.outputPricePerToken).toBeCloseTo(25 / 1_000_000);

    expect(byId.get('claude-fable-5')?.inputPricePerToken).toBeCloseTo(10 / 1_000_000);
    expect(byId.get('claude-fable-5')?.outputPricePerToken).toBeCloseTo(50 / 1_000_000);

    expect(byId.get('claude-sonnet-4-6')?.inputPricePerToken).toBeCloseTo(3 / 1_000_000);
    expect(byId.get('claude-sonnet-4-6')?.outputPricePerToken).toBeCloseTo(15 / 1_000_000);

    expect(byId.get('claude-haiku-4-5-20251001')?.inputPricePerToken).toBeCloseTo(1 / 1_000_000);
    expect(byId.get('claude-haiku-4-5-20251001')?.outputPricePerToken).toBeCloseTo(5 / 1_000_000);
  });

  it('marks every model as code-capable and not reasoning-capable', () => {
    // AeroLink's catalog is Anthropic-Claude-only; every entry supports
    // tool use, and none expose an explicit reasoning/thinking toggle.
    for (const model of buildAeroLinkModels()) {
      expect(model.capabilityCode).toBe(true);
      expect(model.capabilityReasoning).toBe(false);
    }
  });

  it('uses the package default quality score on every model', () => {
    // AeroLink does not publish its own quality ranking; use the same
    // mid-tier score every other catalog entry defaults to so the
    // auto-tier-assigner treats all rows uniformly within a price band.
    for (const model of buildAeroLinkModels()) {
      expect(model.qualityScore).toBe(3);
    }
  });

  it('returns a fresh array on every call (mutations do not leak)', () => {
    const first = buildAeroLinkModels();
    first[0].displayName = 'mutated';

    const second = buildAeroLinkModels();

    expect(second[0].displayName).not.toBe('mutated');
  });

  it('returns rows whose context window is strictly greater than DEFAULT_CONTEXT_WINDOW', () => {
    // Sanity check: the Anthropic-compatible 200K window must exceed the
    // shared default (128K). If this test fails, the catalog regressed
    // below the platform's minimum-acceptable context window for Claude.
    for (const model of buildAeroLinkModels()) {
      expect(model.contextWindow).toBeGreaterThan(DEFAULT_CONTEXT_WINDOW);
    }
  });
});
