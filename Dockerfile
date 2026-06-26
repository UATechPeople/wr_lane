# Single image, single process: Elysia API + React UI. The UI is pre-built with
# Bun.build + the Tailwind plugin (build:web) into dist/ and served as static files.
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN bun run build:web
ENV PORT=3500
ENV NODE_ENV=production
EXPOSE 3500
CMD ["bun", "src/index.ts"]
