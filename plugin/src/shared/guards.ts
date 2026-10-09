// Reading JSON whose shape is not fixed, field by field: a field of anything
// else is undefined.

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function field(v: unknown, key: string): unknown {
  return isObject(v) ? v[key] : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
