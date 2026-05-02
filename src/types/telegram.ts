import { z } from "zod";

/**
 * Wire format for a Telegram message body. `markdown` maps to Telegram's
 * legacy `Markdown` `parse_mode` — keep messages short and avoid characters
 * that need escaping unless you really need formatting.
 */
export const telegramMessageFormatSchema = z.enum(["plain", "markdown"]);

export type TelegramMessageFormat = z.infer<typeof telegramMessageFormatSchema>;

/**
 * Successful sendMessage response shape (we only consume `result.message_id`).
 */
export const telegramSendMessageSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    message_id: z.number(),
  }),
});

/**
 * Telegram error envelope. Shows up on 4xx/5xx and sometimes on 200 with
 * `ok: false`.
 */
export const telegramErrorSchema = z.object({
  ok: z.literal(false),
  description: z.string(),
  error_code: z.number().optional(),
});
