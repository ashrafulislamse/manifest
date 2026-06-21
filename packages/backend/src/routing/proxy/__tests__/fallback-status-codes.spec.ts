import { shouldRotateOnKeyError, shouldTriggerFallback } from '../fallback-status-codes';
import { ROTATION_TRIGGER_STATUSES } from '../../routing-core/key-health.service';

describe('shouldTriggerFallback', () => {
  it.each([400, 401, 403, 404, 405, 409, 422, 424, 429, 500, 501, 502, 503, 504])(
    'should return true for error status %d',
    (status) => {
      expect(shouldTriggerFallback(status)).toBe(true);
    },
  );

  it.each([200, 201, 204, 301, 302])('should return false for non-error status %d', (status) => {
    expect(shouldTriggerFallback(status)).toBe(false);
  });
});

describe('shouldRotateOnKeyError', () => {
  // Cooldown triggers are the only statuses where swapping keys can
  // actually change the outcome — model-level 400/404/422 errors are
  // independent of the API key.
  const rotationStatuses = [...ROTATION_TRIGGER_STATUSES];

  it.each(rotationStatuses)('rotates on cooldown-trigger status %d', (status) => {
    expect(shouldRotateOnKeyError(status)).toBe(true);
  });

  it.each([400, 404, 405, 422, 424])(
    'does NOT rotate on model-level error %d (different key would fail the same way)',
    (status) => {
      expect(shouldRotateOnKeyError(status)).toBe(false);
    },
  );

  it.each([200, 201, 204, 301, 302, 408, 429, 500, 502, 503, 504])(
    'sanity: triggers match the cross-request cooldown set so in-request and cross-request policy stay aligned',
    (status) => {
      const expected = ROTATION_TRIGGER_STATUSES.has(status);
      // 408 and 5xx rotate; 2xx/3xx/4xx model errors don't. The expected
      // truth is the cross-request cooldown set.
      expect(shouldRotateOnKeyError(status)).toBe(expected);
    },
  );
});
