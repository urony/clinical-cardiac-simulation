import registry from "../data/providers.json";

export type ModelRole = "classifier" | "response" | "feedback";
export type Protocol = "openai-responses" | "openai-chat";

export type ProviderSpec = {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  /** Responses-API providers that accept `reasoning.effort`. */
  supportsReasoningEffort?: boolean;
  /** Chat-completions providers: asks thinking models to think briefly ("minimal" | "low" | "medium" | "high"). */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Extra output tokens added to every request: hidden thinking counts against the limit of thinking models. */
  outputTokenHeadroom?: number;
  /** Chat-completions field that limits output length. */
  maxTokensParam?: string;
  /** "json_schema" = strict schema in the request; "json_object" = JSON mode, schema is described in the prompt. */
  structuredOutput: "json_schema" | "json_object";
  defaultModels: Record<ModelRole, string>;
  status: "in-use" | "tested" | "untested";
  /** Shown first and labelled "recommended" to teachers. Only for providers that were really tested. */
  recommended?: boolean;
  /** The free plan was seen to run out quickly in real use. */
  lowFreeQuota?: boolean;
  /** Role name for the instruction message in Responses-API requests (default "developer"). */
  systemRole?: "developer" | "system";
  /** What this provider's keys look like; used only to warn about a pasted value that does not match. */
  keyHint?: { prefix?: string; minLength?: number };
  notes?: string;
  /** Hebrew sentence shown to teachers and students about how the provider may use the content. */
  dataNotice: string;
};

export const providers = registry.providers as ProviderSpec[];
export const DEFAULT_PROVIDER_ID = "openai";

export function getProvider(id: string): ProviderSpec | undefined {
  return providers.find((provider) => provider.id === id);
}

/** A Hebrew warning when a pasted value does not look like a key of this provider (for example a password); null when it looks fine. */
export function keyFormatWarning(provider: ProviderSpec, key: string): string | null {
  const value = key.trim();
  if (!value) return null;
  const { prefix, minLength } = provider.keyHint ?? {};
  if (prefix && !value.startsWith(prefix)) return `הערך לא נראה כמו מפתח של ${provider.name} (מפתחות כאלה מתחילים בדרך כלל ב-${prefix}). ודאו שהדבקתם את המפתח הנכון ולא סיסמה או ערך אחר.`;
  if (minLength && value.length < minLength) return `הערך קצר מהרגיל למפתח של ${provider.name}. ודאו שהדבקתם את המפתח כולו ולא סיסמה.`;
  return null;
}

/** Providers in the order teachers see them: recommended first, then tested, then untested. */
export function providersForTeachers(): ProviderSpec[] {
  const rank = (provider: ProviderSpec) => (provider.recommended ? 0 : provider.status === "untested" ? 2 : 1);
  return [...providers].sort((a, b) => rank(a) - rank(b));
}

/** The label of a provider in the teacher's list. */
export function providerLabel(provider: ProviderSpec): string {
  return `${provider.name}${provider.recommended ? " (מומלץ)" : ""}${provider.status === "untested" ? " (לא נבדק)" : ""}${provider.lowFreeQuota ? " (מכסה חינמית נמוכה)" : ""}`;
}
