FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY config ./config

RUN mkdir -p /app/auth_session /app/data /app/logs /app/config \
    && chown -R node:node /app

USER node

CMD ["node", "dist/index.js"]
