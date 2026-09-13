# Credential Setup Guide

This guide explains where each credential used by `npm run setup` comes from. Never paste credentials into GitHub issues, pull requests, screenshots, or logs.

## Wallet MCP

The bot requires a BudgetBakers Wallet MCP Personal Access Token.

1. Open https://web.budgetbakers.com/settings/mcp-server and sign in to Wallet.
2. Create a Personal Access Token for the MCP server.
3. Grant the scopes required by the features you intend to use. The normal bot workflow expects `records.create`, `records.read`, `accounts.read`, `categories.read`, and `budgets.read`.
4. Copy the token once and enter it when the setup wizard asks for `WALLET_MCP_ACCESS_TOKEN`.

The default MCP endpoint is `https://mcp.wallet.budgetbakers.com`. Change it only when you intentionally use another compatible endpoint.

## Gemini

1. Open Google AI Studio at https://aistudio.google.com/app/apikey.
2. Create or select an API key.
3. Enter the key when the wizard asks for `GEMINI_API_KEY`.
4. Keep the suggested model unless you have a specific model requirement.

## OpenRouter

1. Open https://openrouter.ai/settings/keys.
2. Create an API key.
3. Enter it when the wizard asks for `OPENROUTER_API_KEY`.
4. The wizard uses the OpenRouter API base URL and a default model unless you replace them.

## Groq

1. Open https://console.groq.com/keys.
2. Create an API key.
3. Enter it when the wizard asks for `GROQ_API_KEY`.
4. Keep the suggested Groq model or enter another model available to your account.

## OpenAI

1. Open https://platform.openai.com/api-keys.
2. Create an API key for the project you want to use.
3. Enter it when the wizard asks for `OPENAI_API_KEY`.
4. Keep the suggested model or enter another compatible model.

## Ollama

Ollama normally does not require an API key.

1. Install and start Ollama on the machine that will run the bot.
2. Pull the model you want to use.
3. The default OpenAI-compatible endpoint used by the wizard is `http://localhost:11434/v1`.
4. Enter the installed model name when prompted.

When the bot runs inside Docker, `localhost` refers to the container itself. Configure an endpoint reachable from the container when Ollama runs on the host or another machine.

## Custom OpenAI-compatible provider

For a custom provider, obtain the credential, OpenAI-compatible base URL, and model name from that provider. The endpoint must support the chat completions API used by this project.

The wizard stores the primary custom credential in `AI_API_KEY`, the endpoint in `AI_BASE_URL`, and the model in `AI_MODEL`.

## Telegram

### Create the bot token

1. Open https://t.me/BotFather in Telegram.
2. Send `/newbot`.
3. Follow BotFather's prompts to choose the bot name and username.
4. Copy the generated token and enter it as `TELEGRAM_BOT_TOKEN`.

### Find the allowed user ID

The whitelist requires the immutable numeric Telegram user ID, not a username.

1. Open `@userinfobot` or `@raw_data_bot` in Telegram.
2. Retrieve your numeric user ID.
3. Enter only the digits as `TELEGRAM_ALLOWED_USER_ID`.

Do not share the bot token. If it is exposed, revoke it through BotFather and create a replacement.

## WhatsApp

WhatsApp does not require an API token for this project because the bot uses Baileys multi-device authentication.

1. Enter the single phone number allowed to interact with the bot.
2. Prefer full international E.164 digits without `+`, spaces, or punctuation, for example `6281234567890`.
3. Start the bot after setup.
4. Scan the QR code shown in the terminal with WhatsApp's linked-device flow.
5. Keep the `auth_session` directory persistent. Losing it normally requires pairing again.

The setup wizard never starts the WhatsApp connection itself. `npm run doctor` only checks configuration and whether a previous session exists; it does not initiate QR pairing.

## Gmail IMAP

Email synchronization requires an App Password rather than the normal Google account password.

1. Enable 2-Step Verification on the Google account used for bank notification email.
2. Open https://myaccount.google.com/apppasswords.
3. Create an App Password for the bot.
4. Enter the Gmail address as `EMAIL_IMAP_USER` and the generated App Password as `EMAIL_IMAP_PASSWORD`.
5. Keep the default IMAP host `imap.gmail.com` and port `993` unless your mail provider requires different settings.

If App Passwords are unavailable for the account, check the Google account or organization policy. Do not put the normal account password in `.env` as a workaround.

## Re-running setup safely

Running `npm run setup` with an existing `.env` preserves values that you do not replace. Existing secret prompts display only that a value is configured. Press Enter at a configured secret prompt to keep the current value.

After setup, run:

```bash
npm run doctor
```

The doctor command reports configuration and connectivity status without printing credential values.
