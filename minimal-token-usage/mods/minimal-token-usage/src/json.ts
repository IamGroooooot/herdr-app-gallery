export const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** A string with something in it; anything else is undefined. */
export const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
export const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
