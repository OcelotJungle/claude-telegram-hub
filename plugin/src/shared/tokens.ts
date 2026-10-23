// Token counts as the topic shows them (128k, 1.3M), shared by the hub and
// the plugin's function hooks module.
export const THOUSAND = 1_000;
export const MILLION = 1_000_000;

export function tokens(n: number): string {
  if (n >= MILLION) return `${Number((n / MILLION).toFixed(1))}M`;
  return `${Math.round(n / THOUSAND)}k`;
}
