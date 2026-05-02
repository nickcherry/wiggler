/**
 * One-line top-level usage: `wiggler <command> [options]`.
 */
export function formatTopLevelUsage({
  appName,
}: {
  readonly appName: string;
}): string {
  return `${appName} <command> [options]`;
}
