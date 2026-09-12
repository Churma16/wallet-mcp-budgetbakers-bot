# Docker and Compose Deployment

The repository ships a non-root Node.js 22 container and a Compose configuration for persistent self-hosting.

## Prepare configuration

Create `.env` before starting Compose. Either run the wizard on the host:

```bash
npm run setup
```

or copy and edit the example manually:

```bash
cp .env.example .env
```

Validate the configuration with `npm run doctor` on the host before deployment when possible.

## Start with Compose

Build and start the service:

```bash
docker compose up -d --build
```

Follow startup logs, including the first WhatsApp QR pairing when needed:

```bash
docker compose logs -f wallet-mcp-bot
```

Stop the service with:

```bash
docker compose down
```

Do not use `docker compose down -v` unless you intentionally want to delete persistent named volumes.

## Persistent state

Compose mounts three named volumes:

- `/app/auth_session` stores the Baileys WhatsApp multi-device session. It must survive container recreation to avoid unnecessary re-pairing.
- `/app/data` stores `processed_transaction_cache.json`, which prevents already handled email transactions from being processed again after restart.
- `/app/logs` stores file logs across container recreation.

The image creates these directories before switching to the non-root `node` user so fresh named volumes inherit writable paths.

## Custom category context

The image contains the repository `config` directory. To provide your own category context, create the configured file on the host and add an explicit read-only bind mount to `compose.yaml`, for example:

```yaml
volumes:
  - ./config/category-context.json:/app/config/category-context.json:ro
```

Then set `CATEGORY_CONTEXT_PATH=/app/config/category-context.json` if you do not use the default path.

## Ollama from Docker

The default Ollama URL `http://localhost:11434/v1` works when the bot runs directly on the same host as Ollama. Inside the bot container, `localhost` points to the container itself. Set `AI_BASE_URL` to an address reachable from the container when Ollama runs elsewhere.

## Upgrade

For source builds:

```bash
git pull
docker compose up -d --build
```

Named volumes are retained during ordinary container recreation.
