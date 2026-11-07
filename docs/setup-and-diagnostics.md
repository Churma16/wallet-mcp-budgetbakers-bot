# Setup and Diagnostics

> **Runtime prerequisite:** Node.js 22 or newer. This matches the package metadata, doctor diagnostic, CI runtime, and container image.

## Interactive setup

Install dependencies, then run:

```bash
npm run setup
```

The wizard asks only for what it needs: your Wallet API token, AI choice, messaging credentials, and preferences. Standard defaults like the Wallet MCP URL and standard Gmail IMAP settings are configured automatically.

Need custom ports, IMAP servers, lookback limits, or a custom MCP URL? Pass `--advanced` (or `-a`):

```bash
npm run setup -- --advanced
```

Want to test the wizard without saving any files? Use dry-run mode:

```bash
npm run setup:dry-run
```

The wizard guides you through:

- BudgetBakers Wallet access token (and custom MCP URL with `--advanced`)
- AI provider selection and model configuration. You can choose multiple providers in priority order (e.g. `1,2` for Gemini with OpenRouter fallback) so the bot continues operating if the primary model hits quota or rate limits.
- Messaging channel: WhatsApp (phone number) or Telegram (numeric user ID)
- Language (English or Indonesian), default currency (`USD`, `EUR`, `IDR`), and timezone (detected automatically from your system clock, or search by city name)
- Optional IMAP email synchronization with validation for ports (`1-65535`), emails, and hostnames

Credential prompts include a short hint and a plain-text link to [Credential Setup Guide](setup-credentials.md). Secret values are masked in the terminal and hidden in the final summary.

If `.env` already exists, the wizard updates matching keys while preserving your comments and any custom variables.

## Unified doctor command

Before starting the bot, test your connections and credentials:

```bash
npm run doctor
```

Running in Docker on a server or VPS? Run the doctor directly inside the running container:

```bash
docker exec -it wallet-mcp npm run doctor
```

The doctor performs read-only checks:

- Node.js runtime compatibility.
- Application configuration validation.
- BudgetBakers Wallet authentication and account/category connectivity.
- A minimal test request for each configured AI provider and model (including primary and fallbacks).
- WhatsApp configuration and paired-session presence without starting Baileys or displaying a QR code.
- Telegram bot-token verification when Telegram is enabled.
- IMAP authentication when email sync is enabled, without scanning messages or entering IDLE mode.

Results use plain text statuses:

```text
Wallet MCP System Diagnostics

[SUCCESS] Runtime: Node.js 22.16.0 is supported.
[SUCCESS] Configuration: .env loaded and validated successfully.
[SUCCESS] Wallet MCP: Connected to BudgetBakers API (5 accounts, 24 categories).
[SUCCESS] AI Provider: Gemini responding normally (Primary: gemini-2.5-flash).
[SUCCESS] AI Provider: OpenRouter responding normally (Fallback #1: openrouter/free).
[WARN] WhatsApp: Configuration is valid, but no paired session was found. Start the bot once and scan the QR code.
```

The command exits with code `1` if any check returns `[ERROR]`. Warnings alone keep exit code `0`.

Doctor output intentionally uses generic network failure messages rather than raw upstream exceptions because upstream URLs or error payloads may contain credentials.

## Manual setup

The wizard is optional. To configure manually:

```bash
cp .env.example .env
```

Edit `.env`, then run `npm run doctor`. See [Credential Setup Guide](setup-credentials.md) for token and key acquisition steps.
