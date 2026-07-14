// A tiny feature-flag helper. The scanner classifies `isEnabled(...)` guards
// as `flag` conditions (it's one of the default flag callees).
export function isEnabled(flag: string): boolean {
  return flag.length > 0;
}
