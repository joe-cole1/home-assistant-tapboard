export function paginationHref(
  path: string,
  query: Readonly<Record<string, string | number>>,
  page: number,
  defaults: Readonly<Record<string, string>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === "page" || value === "" || value === defaults[key]) continue;
    params.set(key, String(value));
  }
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded.length === 0 ? path : `${path}?${encoded}`;
}
