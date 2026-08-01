export const NEW_BADGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldShowNewBadge(tap, now = Date.now()) {
  if (!tap || tap.badge_fresh !== 1) return false;

  const onTapAt = Date.parse(tap.on_tap_at);
  if (!Number.isFinite(onTapAt)) return false;

  const age = now - onTapAt;
  return age >= 0 && age < NEW_BADGE_WINDOW_MS;
}
