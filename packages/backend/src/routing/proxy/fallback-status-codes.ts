/**
 * Statuses that should propagate the request to the next configured route
 * in the fallback chain. Anything >= 400 — auth errors, model errors, 5xx,
 * 429 rate limits. The outer fallback chain is the coarse-grained retry:
 * when AeroLink is exhausted and we still have OpenAI / Anthropic, we want
 * to give them a chance.
 */
export function shouldTriggerFallback(status: number): boolean {
  return status >= 400;
}

/**
 * Statuses that warrant swapping to the next API key **within the same
 * route**. The set is intentionally narrower than `shouldTriggerFallback`:
 * model-level errors (400, 404, 422) won't get better with a different key,
 * so rotating is just wasted work. Auth, rate-limit, and transport errors
 * do — different keys carry different per-key usage buckets, so the next
 * key is meaningfully different.
 *
 * Keep this in sync with `KeyHealthService.ROTATION_TRIGGER_STATUSES` — the
 * DB cooldown is only set for statuses that pass through this gate, and we
 * want the in-request rotation policy to match the cross-request cooldown
 * policy so a key that's "hot" right now is also the one we skip in the
 * next request.
 */
export const KEY_ROTATION_TRIGGER_STATUSES = new Set<number>([
  401, 403, 408, 409, 429, 500, 502, 503, 504,
]);

export function shouldRotateOnKeyError(status: number): boolean {
  return KEY_ROTATION_TRIGGER_STATUSES.has(status);
}
