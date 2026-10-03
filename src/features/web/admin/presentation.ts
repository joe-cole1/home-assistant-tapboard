export function volume(ml: number, unit: string): string {
  return unit === "metric" ? `${(ml / 1000).toFixed(1)} L` : `${(ml / 3785.411784).toFixed(1)} gal`;
}

export function capacityLabel(ml: number, unit: string): string {
  return volume(ml, unit);
}

export function tareLabel(grams: number, unit: string): string {
  if (unit === "metric") return `${(grams / 1000).toFixed(2)} kg`;
  const totalOunces = Math.max(0, Math.round(grams / 28.349523125));
  const pounds = Math.floor(totalOunces / 16);
  const ounces = totalOunces % 16;
  return `${pounds} lb ${ounces} oz`;
}

export function isActionableHealth(state: string, severity: string): boolean {
  return state === "active" || severity === "warning" || severity === "critical";
}

export function temperature(c: number, unit: string): string {
  return unit === "metric" ? `${c.toFixed(1)} °C` : `${((c * 9) / 5 + 32).toFixed(1)} °F`;
}

export const ADMIN_TIMESTAMP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function adminTimestampLabel(value: string | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const hour24 = date.getUTCHours();
  const hour = hour24 % 12 || 12;
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${ADMIN_TIMESTAMP_MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour}:${minute} ${hour24 < 12 ? "AM" : "PM"} UTC`;
}
