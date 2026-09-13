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

## GHCR image tags and promotion channels

The `Container` GitHub Actions workflow publishes traceable image tags for non-pull-request builds and supports explicit mutable aliases for deployment.

- `sha-*` identifies the exact source commit used to build the image.
- `vX.Y.Z` is published when the container workflow runs for an official version tag.
- `latest` is updated only by a manual `Container` workflow dispatch with channel `latest`. That dispatch always builds the newest `main` revision, regardless of which workflow ref was selected in the Actions UI.
- `stable` is updated only by a manual dispatch with channel `stable` and an explicit existing official release tag such as `v0.1.6`. The workflow validates the tag, builds that tagged source, republishes the version and `sha-*` tags for that source, and moves the `stable` alias to it.

Routine pushes to `main` do not move `stable`, and publishing a new `vX.Y.Z` tag does not automatically promote it to `stable`. This keeps stable promotion deliberate.

When running the workflow manually:

1. Choose `latest` to promote the current `main` build. Leave the version input empty.
2. Choose `stable` to promote an approved release. Enter an existing `vX.Y.Z` tag in the version input.

Use `latest` when a deployment should follow the newest manually promoted main build, `stable` when it should follow the deliberately approved release, or pin an immutable `sha-*` or explicit `vX.Y.Z` tag when reproducibility is more important than following a mutable channel.

## Upgrade

For source builds:

```bash
git pull
docker compose up -d --build
```

Named volumes are retained during ordinary container recreation.
