export const config = {
  port: Number(process.env.PORT ?? 3500),
  dbPath: process.env.DB_PATH ?? "cabinet.sqlite",
  sharedDir: process.env.SHARED_DIR ?? null,
  winriders: {
    baseUrl: process.env.WR_BASE_URL,
    slug: process.env.WR_SLUG,
    apiKey: process.env.WR_API_KEY,
    playerSegment: process.env.WR_PLAYER_SEGMENT ?? "hidden_base",
    cohort: process.env.WR_COHORT,
    eventType: process.env.WR_EVENT_TYPE ?? "player.registered",
  },
  internal: {
    host: process.env.INTERNAL_HOST ?? "127.0.0.1",
    port: Number(process.env.INTERNAL_PORT ?? 3501),
  },
};
