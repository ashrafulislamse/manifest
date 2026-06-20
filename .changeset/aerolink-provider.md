---
'manifest': minor
---

Add AeroLink as a first-class provider. AeroLink is a third-party Anthropic-compatible proxy at `capi.aerolink.lat` that fronts third-party Claude credits; Manifest now routes `aerolink/*` model ids through it with `x-api-key` auth, fetches its model list from `https://capi.aerolink.lat/v1/models` at discovery time, and links the API-key input directly to `https://aerolink.lat/dashboard/api-keys`. If the live `/v1/models` call fails (auth rejection, network error, or empty response), Manifest transparently falls back to a hand-curated catalog of six Claude models (Opus 4-6/4-7/4-8, Sonnet 4-6, Haiku 4-5, Fable 5) with their published pricing so the routing grid stays populated even when AeroLink is unreachable.