FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN bun run build:web

FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock* ./
RUN bun install --production
COPY tsconfig.json ./
COPY src ./src
COPY bundle ./bundle
COPY --from=builder /app/dist ./dist
ARG BUILD_COMMIT=""
ARG BUILD_TIME=""
ENV BUILD_COMMIT=$BUILD_COMMIT
ENV BUILD_TIME=$BUILD_TIME
ENV PORT=3500
EXPOSE 3500
CMD ["bun", "src/index.ts"]
