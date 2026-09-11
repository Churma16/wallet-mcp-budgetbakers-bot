# Configuration reference

[Back to README](../README.md)

Start with the [quickstart](../README.md#quickstart). Edit existing entries in `.env`, restart the bot after changes, and keep credentials private. [The environment template](../.env.example) is the copyable starting point; [the configuration loader](../src/config/environmentConfig.ts) defines defaults when settings are absent.

## Wallet access token

1. Sign in to [Wallet](https://web.budgetbakers.com).
2. Open Settings > MCP Server, or use [MCP settings](https://web.budgetbakers.com/settings/mcp-server).
3. Create a personal access token with a recognizable name such as `Wallet Bot`.
4. Grant `records.create`, `records.read`, `accounts.read`, `categories.read`, and `budgets.read`.
5. Copy the token into `WALLET_MCP_ACCESS_TOKEN`. Keep it private and revoke it in Wallet settings if exposed.

| Variable | Meaning / loader default |
| --- | --- |
| `WALLET_MCP_BASE_URL` | MCP endpoint; `https://mcp.wallet.budgetbakers.com` |
| `WALLET_MCP_ACCESS_TOKEN` | Personal access token; no default credential |

## AI providers

Gemini is the only provider currently reported as tested by the project. The code also implements OpenAI-compatible connections for OpenRouter, Groq, Ollama, OpenAI, and custom endpoints. Validate your chosen model's structured output and image support before relying on it.

| Variable | Meaning / loader default |
| --- | --- |
| `AI_PROVIDER` | One provider or a comma-separated order; `gemini` |
| `GEMINI_API_KEY` | Gemini credential |
| `GEMINI_MODEL` | Primary Gemini model; loader: `gemini-3.6-flash` |
| `GEMINI_FALLBACK_MODELS` | Ordered Gemini candidates; loader: `gemini-3.5-flash,gemini-3.5-flash-lite` |
| `GEMINI_TIMEOUT_SECONDS` | Gemini request timeout; `20` seconds |
| `OPENROUTER_API_KEY` | OpenRouter credential |
| `GROQ_API_KEY` | Groq credential |
| `OPENAI_API_KEY` | OpenAI credential |
| `AI_API_KEY` | Generic credential override for the primary compatible provider |
| `AI_BASE_URL` | Primary compatible provider endpoint override |
| `AI_MODEL` | Primary compatible provider model override |
| `AI_FALLBACK_MODELS` | Additional compatible model candidates; empty by default |
| `AI_TIMEOUT_SECONDS` | Compatible request timeout; falls back to `GEMINI_TIMEOUT_SECONDS` if set, otherwise `25` |

The template differs from the loader: it selects `gemini-3.5-flash-lite` first and `gemini-3.5-flash,gemini-3.6-flash` as fallbacks. These are repository configuration values, not a statement that those models are available to your account. Set model IDs accepted by your provider.

Compatible providers have these built-in endpoint/model pairs when overrides are absent:

| Provider | Endpoint | Model default in code |
| --- | --- | --- |
| `openrouter` | `https://openrouter.ai/api/v1` | `google/gemini-2.0-flash-exp:free` |
| `groq` | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| `ollama` | `http://localhost:11434/v1` | `llama3.2` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `custom` | Set `AI_BASE_URL` | Set `AI_MODEL` |

Ollama uses a placeholder credential in code; it still requires a running endpoint and an installed model. Do not assume the default model handles receipt images.

### Provider fallback

For example, `AI_PROVIDER=gemini,openrouter` tries Gemini first and then OpenRouter if the operation throws. Supply both provider credentials. This can send the same text or image to both providers.

Generic `AI_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` overrides apply to the primary compatible provider. Secondary providers use their strategy defaults where defined; a shared `AI_MODEL` does not configure every provider in a chain. See [provider construction](../src/services/ai/aiProviderFactory.ts).

If the final provider fails, the error returns to the caller. Fallback is not a persistent retry queue or a guarantee against lost or duplicated transactions.

## Messaging channels

| Variable | Meaning / loader default |
| --- | --- |
| `ENABLED_MESSENGER_CHANNELS` | `whatsapp`, `telegram`, or `whatsapp,telegram`; otherwise inferred from credentials |
| `ALLOWED_PHONE_NUMBER` | WhatsApp user number, including country code |
| `WHATSAPP_SESSION_PATH` | Local credentials directory; `./auth_session` |
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_ALLOWED_USER_ID` | Use the authorized user's numeric Telegram ID |

Always fill in the access restriction for each enabled channel. The code can skip authorization checks when those settings are empty; see [#74](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues/74).

Explicitly choose channels when copying the template: it contains a sample WhatsApp number. For Telegram only, set `ENABLED_MESSENGER_CHANNELS=telegram` and clear `ALLOWED_PHONE_NUMBER`. Telegram accepts username matching in code, but its outgoing notifications use this setting as a chat destination; use a numeric user ID and start the private bot conversation.

Use international digits for WhatsApp, such as `6281234567890`. The loader accepts 7–15 digits and can convert an Indonesian `08...` number when Indonesian regional settings are active. Use the international form to avoid regional ambiguity.

## Regional settings

| Variable | Meaning / loader default |
| --- | --- |
| `APP_LANGUAGE` | `id` or `en`; `id` |
| `DEFAULT_CURRENCY` | Fallback and summary currency; `IDR` |
| `APP_TIMEZONE` | IANA timezone; `Asia/Jakarta` |

Account-specific formatting uses the Wallet account currency. Selecting a fallback currency does not perform currency conversion. The loader also accepts `BOT_LANGUAGE` and `OWNER_PHONE_NUMBER` as legacy fallbacks for language and phone number; prefer the names above.

## Email sync

For Gmail, enable two-step verification and create an app password in your Google account's security settings if available for your account. Use that app password for IMAP, not your regular Google password.

Edit these settings:

```dotenv
EMAIL_SYNC_ENABLED=true
EMAIL_IMAP_HOST=imap.gmail.com
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=your_email@gmail.com
EMAIL_IMAP_PASSWORD=your_app_password
EMAIL_LOOKBACK_MINUTES=10
```

Email sync defaults to disabled. Host, port, and lookback defaults are shown above; the user and password have no default credential.

The listener scans INBOX and uses IMAP IDLE events for new mail. The startup cutoff is the launch time minus `EMAIL_LOOKBACK_MINUTES`; this is not a full historical import. Rules for Mandiri, Jago, GoPay, OVO, DANA, and ShopeePay live in [bankEmailRules.ts](../src/config/bankEmailRules.ts).

Matching messages go to AI extraction, then create pending tickets for confirmation. Message IDs are persisted after downstream handling succeeds; failed handling leaves the message eligible for a later scan within the scan window. Messages rejected by the initial gate are cached immediately.

Tickets are held in memory. Unprocessed tickets expire after 24 hours; processing and uncertain-outcome tickets are retained until resolved in the running process. All tickets disappear on restart. The separate deduplication cache, `data/processed_transaction_cache.json`, does not restore pending tickets or make the queue durable.

## Runtime limits and logs

| Variable | Meaning / loader default |
| --- | --- |
| `WHATSAPP_MAX_RECONNECT_ATTEMPTS` | Reconnection attempt limit; `6` |
| `WHATSAPP_RECONNECT_MAX_BACKOFF_SECONDS` | Backoff cap; `300` seconds |
| `WHATSAPP_MESSAGE_QUEUE_INTERVAL_MS` | Outgoing queue interval; `1000` ms |
| `WHATSAPP_TYPING_PRESENCE_COOLDOWN_MS` | Typing update cooldown; `2500` ms |
| `TELEGRAM_MAX_STARTUP_ATTEMPTS` | Startup attempt limit; `5` |
| `TELEGRAM_STARTUP_RETRY_DELAY_MS` | Startup retry delay; `2000` ms |
| `MAX_MEDIA_DOWNLOAD_MB` | Receipt download limit; `10` MB |
| `LOG_RETENTION_DAYS` | Daily log retention; `7` days |
| `DEBUG_FINANCIAL_PAYLOADS` | Opt in to detailed financial payload logging; `false` (read by the logging policy) |

These limits bound retries, outgoing traffic, and downloads; they do not prevent every disconnection or account restriction. The application summarizes detailed financial payloads as metadata by default. Enable `DEBUG_FINANCIAL_PAYLOADS=true` only for intentional local debugging: amounts, notes, merchants, prompts, and model responses may be written to disk. Credential redaction remains active. Review and sanitize logs before sharing them.
