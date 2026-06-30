# Multi-stage: the React UI and all its (dev) deps stay in the builder; the runtime
# image carries only the server, production deps, and the prebuilt dist/.

# ---- builder: full install + build the React UI into dist/ ----
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN bun run build:web

# ---- runtime: production deps + server + prebuilt UI only ----
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock* ./
RUN bun install --production
COPY tsconfig.json ./
COPY src ./src
COPY --from=builder /app/dist ./dist
ENV PORT=3500
EXPOSE 3500
CMD ["bun", "src/index.ts"]
