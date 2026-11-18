// Generated from src/json.ts. Edit the TS source, then run npm run verify.
export const object = (value) => typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
/** A string with something in it; anything else is undefined. */
export const text = (value) => (typeof value === 'string' && value ? value : undefined);
export const finite = (n) => typeof n === 'number' && Number.isFinite(n);
export function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
