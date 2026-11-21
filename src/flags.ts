/** An env var or plugin option that switches something on: 1, true, yes or on (any case). */
export const isTruthyFlag = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test(v ?? "");
