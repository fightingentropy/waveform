export function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function envString(env: CloudflareEnv, key: string): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

export function envStringList(env: CloudflareEnv, key: string): string[] {
  return envString(env, key)
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function toNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
