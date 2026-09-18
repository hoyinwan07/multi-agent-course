/**
 * "Today" means midnight UTC, everywhere it's used (`GET /stats`, the `DEEP_DAILY_CAP`
 * gate) — matching how every `createdAt` in this service is written
 * (`new Date().toISOString()`). A local-timezone boundary would make either number jump
 * at a different moment than the data it is read from actually resets.
 */
export function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** When a `DEEP_DAILY_CAP` 429 tells the caller to try again — the contract's `resetsAt`. */
export function nextUtcMidnightIso(): string {
  const start = startOfUtcDay();
  return new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
}
