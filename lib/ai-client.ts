import { extractOpenAIError, extractOpenAIText, type OpenAIResponsesPayload } from "./openai-response";
import { getProvider, type ModelRole, type ProviderSpec } from "./providers";

/**
 * Provider-neutral model access. The simulation describes WHAT it needs (a system instruction, the
 * user's text, optionally a JSON schema) and this layer turns it into the request each provider
 * expects. Provider names, URLs and model names come from data/providers.json, never from the
 * simulation logic. The browser calls the provider directly, so the key lives only in the page.
 */
export type ModelConfig = {
  providerId: string;
  apiKey: string;
  /** Overrides the provider's recommended model per role (e.g. chosen by the teacher). */
  models?: Partial<Record<ModelRole, string>>;
};

export type CompletionRequest = {
  role: ModelRole;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** When set, the model must answer with JSON that matches `schema`. */
  json?: { name: string; schema: Record<string, unknown> };
};

export type ErrorKind = "config" | "network" | "auth" | "quota" | "rate_limit" | "provider" | "bad_response" | "invalid_request";

/** An error whose message is safe and meaningful to show to the user. */
export class SimulationError extends Error {
  status: number;
  kind: ErrorKind;
  constructor(message: string, status = 502, kind: ErrorKind = "provider") { super(message); this.status = status; this.kind = kind; }
}

export function resolveModel(config: ModelConfig, provider: ProviderSpec, role: ModelRole) {
  return config.models?.[role] || provider.defaultModels[role];
}

/** Request body for OpenAI-style Responses APIs (OpenAI, xAI). */
export function buildResponsesBody(provider: ProviderSpec, model: string, request: CompletionRequest) {
  return {
    model,
    ...(provider.supportsReasoningEffort ? { reasoning: { effort: "low" } } : {}),
    max_output_tokens: request.maxOutputTokens,
    input: [
      { role: "developer", content: [{ type: "input_text", text: request.system }] },
      { role: "user", content: [{ type: "input_text", text: request.user }] },
    ],
    ...(request.json ? { text: { format: { type: "json_schema", name: request.json.name, strict: true, schema: request.json.schema } } } : {}),
  };
}

/** Request body for OpenAI-style Chat Completions APIs (Groq, Gemini, OpenRouter, Mistral). */
export function buildChatBody(provider: ProviderSpec, model: string, request: CompletionRequest) {
  const describeSchema = request.json && provider.structuredOutput === "json_object"
    ? `\nהחזר JSON תקין בלבד, שתואם בדיוק לסכמה הזו: ${JSON.stringify(request.json.schema)}`
    : "";
  return {
    model,
    [provider.maxTokensParam || "max_tokens"]: request.maxOutputTokens,
    messages: [
      { role: "system", content: request.system + describeSchema },
      { role: "user", content: request.user },
    ],
    ...(request.json
      ? { response_format: provider.structuredOutput === "json_schema" ? { type: "json_schema", json_schema: { name: request.json.name, strict: true, schema: request.json.schema } } : { type: "json_object" } }
      : {}),
  };
}

type ChatPayload = { choices?: { message?: { content?: unknown } }[]; error?: { message?: unknown } };

function extractChatText(payload: ChatPayload): string | null {
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function classify(status: number, message: string): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return /credit|quota|billing|insufficient/i.test(message) ? "quota" : "rate_limit";
  return "provider";
}

export async function complete(config: ModelConfig, request: CompletionRequest): Promise<string> {
  const provider = getProvider(config.providerId);
  if (!provider) throw new SimulationError("ספק ה־AI שנבחר אינו מוכר.", 400, "config");
  if (!config.apiKey) throw new SimulationError("לא הוגדר מפתח AI.", 503, "config");
  const model = resolveModel(config, provider, request.role);
  const responses = provider.protocol === "openai-responses";
  const url = `${provider.baseUrl}${responses ? "/responses" : "/chat/completions"}`;
  const body = responses ? buildResponsesBody(provider, model, request) : buildChatBody(provider, model, request);

  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body) });
  } catch {
    throw new SimulationError("לא ניתן להגיע לספק ה־AI. בדקו את החיבור לאינטרנט.", 502, "network");
  }
  const payload = await response.json().catch(() => ({})) as OpenAIResponsesPayload & ChatPayload;
  const output = responses ? extractOpenAIText(payload) : extractChatText(payload);
  if (!response.ok || !output) {
    const detail = (responses ? extractOpenAIError(payload) : typeof payload.error?.message === "string" ? payload.error.message : null) || "לא התקבלה תשובה קריאה.";
    throw new SimulationError(`${provider.name} API (${response.status}): ${detail}`, 502, response.ok ? "bad_response" : classify(response.status, detail));
  }
  return output;
}
