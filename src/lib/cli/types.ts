import type { output, ZodTypeAny } from "zod";

export type CliIo = {
  writeStdout(text: string): void;
  writeStderr(text: string): void;
};

export type CliBaseInputDefinition<
  TKey extends string = string,
  TSchema extends ZodTypeAny = ZodTypeAny,
> = {
  readonly key: TKey;
  readonly schema: TSchema;
  readonly description?: string;
  readonly choices?: readonly string[];
};

export type CliFlagOptionDefinition<
  TKey extends string = string,
  TSchema extends ZodTypeAny = ZodTypeAny,
> = CliBaseInputDefinition<TKey, TSchema> & {
  readonly kind: "flag";
  readonly long: `--${string}`;
  readonly short?: `-${string}`;
};

export type CliValueOptionDefinition<
  TKey extends string = string,
  TSchema extends ZodTypeAny = ZodTypeAny,
> = CliBaseInputDefinition<TKey, TSchema> & {
  readonly kind: "value";
  readonly long: `--${string}`;
  readonly short?: `-${string}`;
  readonly valueName: string;
};

export type CliOptionDefinition<
  TKey extends string = string,
  TSchema extends ZodTypeAny = ZodTypeAny,
> =
  | CliFlagOptionDefinition<TKey, TSchema>
  | CliValueOptionDefinition<TKey, TSchema>;

export type CliPositionalDefinition<
  TKey extends string = string,
  TSchema extends ZodTypeAny = ZodTypeAny,
> = CliBaseInputDefinition<TKey, TSchema> & {
  readonly valueName: string;
};

type InferDefinitionValue<TDefinition> = TDefinition extends {
  schema: infer TSchema extends ZodTypeAny;
}
  ? output<TSchema>
  : never;

export type InferOptions<TDefinitions extends readonly CliOptionDefinition[]> =
  {
    readonly [TDefinition in TDefinitions[number] as TDefinition["key"]]: InferDefinitionValue<TDefinition>;
  };

export type InferPositionals<
  TDefinitions extends readonly CliPositionalDefinition[],
> = {
  readonly [TDefinition in TDefinitions[number] as TDefinition["key"]]: InferDefinitionValue<TDefinition>;
};

export type CliCommandRunContext<
  TOptions extends Record<string, unknown>,
  TPositionals extends Record<string, unknown>,
> = {
  readonly io: CliIo;
  readonly options: TOptions;
  readonly positionals: TPositionals;
  readonly rawArgv: readonly string[];
};

export type CliCommandDefinition<
  TOptions extends readonly CliOptionDefinition[] = readonly CliOptionDefinition[],
  TPositionals extends
    readonly CliPositionalDefinition[] = readonly CliPositionalDefinition[],
> = {
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly options?: TOptions;
  readonly positionals?: TPositionals;
  readonly examples?: readonly string[];
  readonly output: string;
  readonly sideEffects: string;
  readonly hidden?: boolean;
  run(
    context: CliCommandRunContext<
      InferOptions<TOptions>,
      InferPositionals<TPositionals>
    >,
  ): Promise<void>;
};

export type CliAnyCommandDefinition = CliCommandDefinition<
  readonly CliOptionDefinition[],
  readonly CliPositionalDefinition[]
>;

export type CliAppDefinition = {
  readonly name: string;
  readonly summary: string;
  readonly commands: readonly CliAnyCommandDefinition[];
};

export type CliApp = {
  run(argv: readonly string[], io?: CliIo): Promise<void>;
  runWithErrorBoundary(argv: readonly string[], io?: CliIo): Promise<void>;
  renderAppHelp(): string;
  renderCommandHelp(commandName: string): string;
};
