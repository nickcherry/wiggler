import {
  telegramErrorSchema,
  telegramSendMessageSuccessSchema,
  type TelegramMessageFormat,
} from "@wiggler/types/telegram";

const telegramApiBaseUrl = "https://api.telegram.org";

type SendTelegramMessageParams = {
  readonly botToken: string;
  readonly chatId: string;
  readonly text: string;
  readonly format?: TelegramMessageFormat;
};

export type SendTelegramMessageResult = {
  readonly messageId: number;
};

/**
 * Sends a single Telegram message via the Bot API. Validates the response
 * shape with Zod and throws a descriptive error when Telegram reports
 * `ok: false` or returns a non-2xx status.
 *
 * Pure side-effect at the HTTP boundary — no env access, no DB. Wire callers
 * are responsible for resolving the bot token and chat id.
 */
export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  format = "plain",
}: SendTelegramMessageParams): Promise<SendTelegramMessageResult> {
  if (text.trim().length === 0) {
    throw new Error("Telegram messages must contain non-empty text.");
  }

  const url = `${telegramApiBaseUrl}/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(format === "markdown" ? { parse_mode: "Markdown" } : {}),
    }),
  });

  const rawBody = await response.text();
  const payload = parseJsonResponse({ rawBody });

  if (!response.ok) {
    const error = telegramErrorSchema.safeParse(payload);
    const description = error.success ? error.data.description : rawBody;
    throw new Error(
      `Telegram sendMessage failed with HTTP ${response.status}: ${description}`,
    );
  }

  const error = telegramErrorSchema.safeParse(payload);
  if (error.success) {
    throw new Error(`Telegram sendMessage failed: ${error.data.description}`);
  }

  const success = telegramSendMessageSuccessSchema.parse(payload);
  return { messageId: success.result.message_id };
}

function parseJsonResponse({ rawBody }: { readonly rawBody: string }): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("Telegram API returned a non-JSON response.");
  }
}
