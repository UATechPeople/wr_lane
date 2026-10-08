import { z } from "zod";
import { config } from "./config";
import { getSetting, setSetting } from "./db";

export const crmConfigSchema = z.object({
  url: z.string().url().or(z.literal("")).default(""),
  headers: z.record(z.string().min(1).max(128), z.string().max(2048)).default({}),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
});

export type CrmConfig = z.infer<typeof crmConfigSchema>;

export const DEFAULT_CRM_CONFIG: CrmConfig = {
  url: "",
  headers: {},
  timeoutMs: 10_000,
};

export const PLATFORM_TARGET_FIELDS = [
  "phone_e164",
  "country",
  "language",
  "first_name",
  "last_name",
  "player_segment",
  "cohort",
] as const;

export const PLATFORM_SOURCE_FIELDS = ["token", "user_id", "country", "language", "first_name", "last_name", "segment", "cohort"] as const;

export const TOKEN_ONLY_TARGETS = ["phone_e164"] as const;

export type PlatformTarget = (typeof PLATFORM_TARGET_FIELDS)[number];
export type PlatformSource = (typeof PLATFORM_SOURCE_FIELDS)[number];

export const DEFAULT_PLATFORM_FIELDS: { as: PlatformTarget; from: PlatformSource }[] = [
  { as: "phone_e164", from: "token" },
  { as: "player_segment", from: "segment" },
  { as: "cohort", from: "cohort" },
];

const platformFieldSchema = z.object({
  as: z.enum(PLATFORM_TARGET_FIELDS),
  from: z.enum(PLATFORM_SOURCE_FIELDS),
});

export const platformConfigSchema = z.object({
  baseUrl: z.string().url("The platform url is required"),
  slug: z.string().min(1, "client slug is required").max(128),
  apiKey: z.string().min(1, "api key is required").max(512),
  playerSegment: z.string().min(1, "segment is required").max(128),
  eventType: z.string().min(1).max(64).default("player.registered"),
  cohort: z.string().max(128).optional(),
  fields: z.array(platformFieldSchema).max(16).default(DEFAULT_PLATFORM_FIELDS),
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
        message: `${target} may only carry the token — mapping a real phone number there would send it to the platform`,
      });
    }
  }
});

export type PlatformConfig = z.infer<typeof platformConfigSchema>;

export type StoredPlatformConfig = {
  baseUrl: string;
  slug: string;
  apiKey: string;
  playerSegment: string;
  eventType: string;
  cohort?: string;
  fields: { as: PlatformTarget; from: PlatformSource }[];
};

const PLATFORM_KEY = "wr_connection";

const DEFAULT_PLATFORM: StoredPlatformConfig = {
  baseUrl: "",
  slug: "",
  apiKey: "",
  playerSegment: "hidden_base",
  eventType: "player.registered",
  fields: DEFAULT_PLATFORM_FIELDS,
};

const LEGACY_PLATFORM_TARGETS = new Set(["external_id"]);

function dropLegacyFields(cfg: StoredPlatformConfig): StoredPlatformConfig {
  return { ...cfg, fields: cfg.fields.filter((f) => !LEGACY_PLATFORM_TARGETS.has(f.as)) };
}

export function getPlatformConfig(): StoredPlatformConfig {
  const raw = getSetting(PLATFORM_KEY);
  if (raw) return dropLegacyFields({ ...DEFAULT_PLATFORM, ...(JSON.parse(raw) as Partial<StoredPlatformConfig>) });

  const seeded: StoredPlatformConfig = {
    ...DEFAULT_PLATFORM,
    baseUrl: config.platform.baseUrl ?? "",
    slug: config.platform.slug ?? "",
    apiKey: config.platform.apiKey ?? "",
    playerSegment: config.platform.playerSegment,
    eventType: config.platform.eventType,
    ...(config.platform.cohort ? { cohort: config.platform.cohort } : {}),
  };

  if (seeded.baseUrl || seeded.slug || seeded.apiKey) {
    setSetting(PLATFORM_KEY, JSON.stringify(seeded));
  }
  return seeded;
}

export function savePlatformConfig(input: unknown): PlatformConfig {
  const parsed = platformConfigSchema.parse(input);
  setSetting(PLATFORM_KEY, JSON.stringify(parsed));
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
