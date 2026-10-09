// Sessions should last 30 minutes; the bug is that they expire after 5.
export const SESSION_TTL_MINUTES = 5

export function isExpired(startedAt, now) {
  return now - startedAt > SESSION_TTL_MINUTES * 60 * 1000
}
