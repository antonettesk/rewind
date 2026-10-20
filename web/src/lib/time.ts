export function msBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  return a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null;
}
