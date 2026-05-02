/**
 * Error thrown for command-line usage problems (unknown command, missing
 * required option, invalid value, etc). Carries an optional `usage` string
 * that the runtime prints alongside the message.
 */
export class CliUsageError extends Error {
  readonly usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = "CliUsageError";
    this.usage = usage;
  }
}
