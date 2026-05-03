import type { CliOptionDefinition } from "@alea/lib/cli/types";

export type ParsedOptionToken = {
  readonly option: CliOptionDefinition | undefined;
  readonly inlineValue: string | undefined;
};

/**
 * Decodes a single argv token into either a recognized option (with optional
 * inline value via `--key=value`) or `option: undefined` if it doesn't match
 * any known long/short flag.
 */
export function parseOptionToken({
  token,
  longOptions,
  shortOptions,
}: {
  readonly token: string;
  readonly longOptions: ReadonlyMap<string, CliOptionDefinition>;
  readonly shortOptions: ReadonlyMap<string, CliOptionDefinition>;
}): ParsedOptionToken {
  const equalsIndex = token.indexOf("=");
  if (equalsIndex >= 0) {
    const flag = token.slice(0, equalsIndex);
    const value = token.slice(equalsIndex + 1);
    const option = longOptions.get(flag) ?? shortOptions.get(flag);
    return { option, inlineValue: value };
  }

  const option = longOptions.get(token) ?? shortOptions.get(token);
  return { option, inlineValue: undefined };
}
