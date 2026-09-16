import { z } from "zod";
import { config } from "./config";
import { getSetting, setSetting } from "./db";

export const WEBHOOK_ID_TOKEN = "{id}";

export const crmConfigSchema = z.object({
  url: z.string().url().or(z.literal("")).default(""),
  urlTemplate: z
    .string()
    .max(512)
    .default("")
    .refine((v) => v === "" || (v.includes(WEBHOOK_ID_TOKEN) && /^https?:\/\//.test(v)), {
      message: `template must be a url containing ${WEBHOOK_ID_TOKEN}`,
    }),
  headers: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
});

export type CrmConfig = z.infer<typeof crmConfigSchema>;

export const DEFAULT_CRM_CONFIG: CrmConfig = {
  url: "",
  urlTemplate: "",
  headers: {},
  timeoutMs: 10_000,
};

export const WR_TARGET_FIELDS = [
  "phone_e164",
  "country",
  "language",
  "first_name",
  "last_name",
  "player_segment",
  "cohort",
] as const;

export const WR_SOURCE_FIELDS = ["token", "user_id", "country", "language", "first_name", "last_name", "segment", "cohort"] as const;

export const TOKEN_ONLY_TARGETS = ["phone_e164"] as const;

export type WrTarget = (typeof WR_TARGET_FIELDS)[number];
export type WrSource = (typeof WR_SOURCE_FIELDS)[number];

export const DEFAULT_WR_FIELDS: { as: WrTarget; from: WrSource }[] = [
  { as: "phone_e164", from: "token" },
  { as: "player_segment", from: "segment" },
  { as: "cohort", from: "cohort" },
];

const wrFieldSchema = z.object({
  as: z.enum(WR_TARGET_FIELDS),
  from: z.enum(WR_SOURCE_FIELDS),
});

export const wrConfigSchema = z.object({
  baseUrl: z.string().url("WinRiders url is required"),
  slug: z.string().min(1, "client slug is required").max(128),
  apiKey: z.string().min(1, "api key is required").max(512),
  playerSegment: z.string().min(1, "segment is required").max(128),
  eventType: z.string().min(1).max(64).default("player.registered"),
  cohort: z.string().max(128).optional(),
  fields: z.array(wrFieldSchema).max(16).default(DEFAULT_WR_FIELDS),
}).superRefine((cfg, ctx) => {
  for (const target of TOKEN_ONLY_TARGETS) {
    const mapped = cfg.fields.find((f) => f.as === target);
    if (!mapped) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["fields"], message: `${target} must be mapped` });
      continue;
    }
    if (mapped.from !== "token") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fields"],
        message: `${target} may only carry the token — mapping a real phone number there would send it to WinRiders`,
      });
    }
  }
});

export type WrConfig = z.infer<typeof wrConfigSchema>;

export type StoredWrConfig = {
  baseUrl: string;
  slug: string;
  apiKey: string;
  playerSegment: string;
  eventType: string;
  cohort?: string;
  fields: { as: WrTarget; from: WrSource }[];
};

const WR_KEY = "wr_connection";

const DEFAULT_WR: StoredWrConfig = {
  baseUrl: "",
  slug: "",
  apiKey: "",
  playerSegment: "hidden_base",
  eventType: "player.registered",
  fields: DEFAULT_WR_FIELDS,
};

const LEGACY_WR_TARGETS = new Set(["external_id"]);

function dropLegacyFields(cfg: StoredWrConfig): StoredWrConfig {
  return { ...cfg, fields: cfg.fields.filter((f) => !LEGACY_WR_TARGETS.has(f.as)) };
}

export function getWrConfig(): StoredWrConfig {
  const raw = getSetting(WR_KEY);
  if (raw) return dropLegacyFields({ ...DEFAULT_WR, ...(JSON.parse(raw) as Partial<StoredWrConfig>) });

  const seeded: StoredWrConfig = {
    ...DEFAULT_WR,
    baseUrl: config.winriders.baseUrl ?? "",
    slug: config.winriders.slug ?? "",
    apiKey: config.winriders.apiKey ?? "",
    playerSegment: config.winriders.playerSegment,
    eventType: config.winriders.eventType,
    ...(config.winriders.cohort ? { cohort: config.winriders.cohort } : {}),
  };

  if (seeded.baseUrl || seeded.slug || seeded.apiKey) {
    setSetting(WR_KEY, JSON.stringify(seeded));
  }
  return seeded;
}

export function saveWrConfig(input: unknown): WrConfig {
  const parsed = wrConfigSchema.parse(input);
  setSetting(WR_KEY, JSON.stringify(parsed));
  return parsed;
}

const CRM_KEY = "crm_webhook";
const INBOUND_KEY = "inbound_key";
const CORE_KEY = "core_key";

export function getCrmConfig(): CrmConfig {
  const raw = getSetting(CRM_KEY);
  if (!raw) return DEFAULT_CRM_CONFIG;
  const parsed = crmConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return DEFAULT_CRM_CONFIG;
  return parsed.data;
}

export function saveCrmConfig(input: unknown): CrmConfig {
  const parsed = crmConfigSchema.parse(input);
  setSetting(CRM_KEY, JSON.stringify(parsed));
  return parsed;
}

export type ResultFacts = {
  phone: string | null;
  call_id: string;
  result: string | null;
  payload: unknown;
};

export const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isWebhookId(value: string | null | undefined): value is string {
  return typeof value === "string" && WEBHOOK_ID_PATTERN.test(value);
}

export function resolveCrmUrl(config: CrmConfig, webhookId: string | null | undefined): string {
  if (config.urlTemplate && isWebhookId(webhookId)) {
    return config.urlTemplate.replaceAll(WEBHOOK_ID_TOKEN, webhookId);
  }
  return config.url;
}

export function parsePayload(raw: string | null | undefined): unknown {
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function buildResultBody(facts: ResultFacts): Record<string, unknown> {
  return {
    phone: facts.phone,
    call_id: facts.call_id,
    result: facts.result,
    payload: facts.payload ?? null,
  };
}

function readKey(key: string): string | null {
  return getSetting(key);
}

export function getInboundKey(): string | null {
  return readKey(INBOUND_KEY);
}

export function getCoreKey(): string | null {
  return readKey(CORE_KEY);
}

export function setInboundKey(value: string): void {
  setSetting(INBOUND_KEY, value);
}

export function setCoreKey(value: string): void {
  setSetting(CORE_KEY, value);
}
