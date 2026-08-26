export const CLIENT_RESULTS = [
  "send_sms",
  "no_answer",
  "voicemail",
  "busy",
  "hang_up",
  "not_interested",
  "failed_call",
  "blacklist",
] as const;

export type ClientResult = (typeof CLIENT_RESULTS)[number];

const RESULT_BY_OUTCOME: Record<string, ClientResult> = {
  agreed: "send_sms",
  interested: "send_sms",
  positive_sentiment: "send_sms",
  no_answer: "no_answer",
  voicemail: "voicemail",
  busy: "busy",
  short_call: "hang_up",
  rejected: "hang_up",
  not_interested: "not_interested",
  declined: "not_interested",
  negative_sentiment: "not_interested",
  telephony_failure: "failed_call",
  dnc: "blacklist",
  self_excluded: "blacklist",
};

export function resultForOutcome(outcome: string | null | undefined): ClientResult | null {
  if (!outcome) return null;
  return RESULT_BY_OUTCOME[outcome] ?? null;
}

export function mappedOutcomes(): string[] {
  return Object.keys(RESULT_BY_OUTCOME);
}
