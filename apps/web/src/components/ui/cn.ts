/** Join class names, dropping falsy values. Small on purpose — this is not a styling framework. */
export function cn(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}
