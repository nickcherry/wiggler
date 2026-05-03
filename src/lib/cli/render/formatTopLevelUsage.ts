/**
 * One-line top-level usage: `alea <command> [options]`.
 */
export function formatTopLevelUsage({
  appName,
}: {
  readonly appName: string;
}): string {
  return `${appName} <command> [options]`;
}
