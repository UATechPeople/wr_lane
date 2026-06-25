# Single image, single process: Elysia API + React UI (Bun bundles the React from
# public/ at runtime via the HTML import — no Vite, no separate build stage).
FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
ENV PORT=3500
ENV NODE_ENV=production
EXPOSE 3500
CMD ["bun", "src/index.ts"]
