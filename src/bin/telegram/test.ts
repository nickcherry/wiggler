import { env } from "@alea/constants/env";
import { defineCommand } from "@alea/lib/cli/defineCommand";
import { defineValueOption } from "@alea/lib/cli/defineValueOption";
import { sendTelegramMessage } from "@alea/lib/telegram/sendTelegramMessage";
import { telegramMessageFormatSchema } from "@alea/types/telegram";
import pc from "picocolors";
import { z } from "zod";

const defaultText = "alea telegram test ✅";

/**
 * Sends a single test message to the configured Telegram chat to verify the
 * bot token and chat id are wired correctly.
 */
export const telegramTestCommand = defineCommand({
  name: "telegram:test",
  summary: "Send a test message to the configured Telegram chat",
  description:
    "Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from the environment and posts a single message via the Telegram Bot API. Useful for validating credentials, network access, and the bot's permissions in the destination chat.",
  options: [
    defineValueOption({
      key: "text",
      long: "--text",
      short: "-t",
      valueName: "TEXT",
      schema: z
        .string()
        .min(1)
        .default(defaultText)
        .describe("Message body to send."),
    }),
    defineValueOption({
      key: "format",
      long: "--format",
      valueName: "FORMAT",
      choices: ["plain", "markdown"],
      schema: telegramMessageFormatSchema
        .default("plain")
        .describe("Message parse mode."),
    }),
  ],
  examples: [
    "bun alea telegram:test",
    'bun alea telegram:test --text "hi from alea"',
    'bun alea telegram:test --format markdown --text "*bold* and _italic_"',
  ],
  output: "Prints the resulting Telegram message id on success.",
  sideEffects:
    "Sends one message to the chat identified by TELEGRAM_CHAT_ID using TELEGRAM_BOT_TOKEN.",
  async run({ io, options }) {
    const botToken = env.telegramBotToken;
    const chatId = env.telegramChatId;

    if (!botToken) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set in the environment.");
    }
    if (!chatId) {
      throw new Error("TELEGRAM_CHAT_ID is not set in the environment.");
    }

    const result = await sendTelegramMessage({
      botToken,
      chatId,
      text: options.text,
      format: options.format,
    });

    io.writeStdout(
      `${pc.green("sent")}  ${pc.dim("chat=")}${chatId}  ${pc.dim("message_id=")}${result.messageId}\n`,
    );
  },
});
