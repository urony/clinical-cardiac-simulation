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
  status: "in-use" | "untested";
  notes?: string;
  /** Hebrew sentence shown to teachers and students about how the provider may use the content. */
  dataNotice: string;
};

export const providers = registry.providers as ProviderSpec[];
export const DEFAULT_PROVIDER_ID = "openai";

export function getProvider(id: string): ProviderSpec | undefined {
  return providers.find((provider) => provider.id === id);
}
