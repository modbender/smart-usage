// Type guards for JSON read from files and undocumented endpoints.

export type Json = Record<string, unknown>;

/** A plain JSON object: not null, not an array. */
export const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export const asObj = (v: unknown): Json | null => (isObj(v) ? v : null);

export const nonEmptyString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A finite number, or null (NaN, Infinity, strings and missing values all read as null). */
export const finiteNumber = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
