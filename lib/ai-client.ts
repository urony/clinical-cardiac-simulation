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
  /** Upper bound for every answer length (teacher setting). */
  maxOutputTokens?: number;
  /** Called before every provider request; may throw to refuse it (e.g. a usage limit). */
  beforeCall?: () => void;
  /** How long to wait for the provider before giving up. Default 60 seconds. */
  timeoutMs?: number;
  /** Pause before the single automatic retry of a network or server (5xx) failure. Default 1500 ms. */
  retryDelayMs?: number;
};

export type CompletionRequest = {
  role: ModelRole;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** When set, the model must answer with JSON that matches `schema`. */
  json?: { name: string; schema: Record<string, unknown> };
};

export type ErrorKind = "config" | "network" | "timeout" | "auth" | "quota" | "rate_limit" | "model" | "provider" | "bad_response" | "invalid_request" | "teacher_limit" | "truncated";

/**
 * An error whose `message` is Hebrew, safe and meaningful to show to a student. `detail` is the
 * provider's own wording (often English) for a teacher or for debugging; it never contains the key.
 */
export class SimulationError extends Error {
  status: number;
  kind: ErrorKind;
  detail?: string;
  constructor(message: string, status = 502, kind: ErrorKind = "provider", detail?: string) { super(message); this.status = status; this.kind = kind; this.detail = detail; }
}

/** What a student sees for each failure. None of these pretends the simulation is still running. */
export const failureMessages: Record<Exclude<ErrorKind, "config" | "invalid_request" | "teacher_limit">, string> = {
  network: "לא ניתן להגיע לספק ה־AI. בדקו את החיבור לאינטרנט ונסו שוב.",
  timeout: "ספק ה־AI לא ענה בזמן. נסו שוב בעוד רגע.",
  auth: "הספק דחה את המפתח של המורה (שגוי, בוטל או ללא הרשאה). הסימולציה לא יכולה להמשיך. פנו למורה.",
  quota: "המכסה או היתרה של המורה אצל ספק ה־AI נגמרו או שהוגבלו. הסימולציה לא יכולה להמשיך כרגע. המתינו דקה ונסו שוב, ואם זה חוזר פנו למורה.",
  rate_limit: "הספק מגביל כרגע את מספר הפניות. המתינו כמה שניות ונסו שוב.",
  model: "המודל שהמורה בחר אינו זמין עם המפתח הזה. הסימולציה לא יכולה להמשיך. פנו למורה.",
  provider: "שירות ה־AI של הספק אינו זמין כרגע. נסו שוב בעוד רגע.",
  bad_response: "התקבלה תשובה לא תקינה מהספק. נסו שוב או נסחו את השאלה מחדש.",
  truncated: "המודל לא הספיק לסיים את התשובה (נגמרה מגבלת האורך). נסו שוב, ואם זה חוזר פנו למורה.",
};

export function resolveModel(config: ModelConfig, provider: ProviderSpec, role: ModelRole) {
  return config.models?.[role] || provider.defaultModels[role];
}

/** Request body for OpenAI-style Responses APIs (OpenAI, xAI). */
export function buildResponsesBody(provider: ProviderSpec, model: string, request: CompletionRequest) {
  return {
    model,
    ...(provider.supportsReasoningEffort ? { reasoning: { effort: "low" } } : {}),
    max_output_tokens: request.maxOutputTokens + (provider.outputTokenHeadroom ?? 0),
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
    [provider.maxTokensParam || "max_tokens"]: request.maxOutputTokens + (provider.outputTokenHeadroom ?? 0),
    ...(provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
    messages: [
      { role: "system", content: request.system + describeSchema },
      { role: "user", content: request.user },
    ],
    ...(request.json
      ? { response_format: provider.structuredOutput === "json_schema" ? { type: "json_schema", json_schema: { name: request.json.name, strict: true, schema: request.json.schema } } : { type: "json_object" } }
      : {}),
  };
}

type ChatPayload = {
  choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
  error?: { message?: unknown };
  usage?: { completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } };
  status?: unknown;
  incomplete_details?: { reason?: unknown };
};

/** Short, safe description of why a reply had no usable text (shown to the teacher, never contains the key). */
function describeReply(payload: ChatPayload, responses: boolean): { text: string; truncated: boolean } {
  const parts: string[] = [];
  let truncated = false;
  if (responses) {
    if (typeof payload.status === "string") parts.push(`status: ${payload.status}`);
    const reason = payload.incomplete_details?.reason;
    if (typeof reason === "string") { parts.push(`incomplete: ${reason}`); truncated = /max/i.test(reason); }
  } else {
    const finish = payload.choices?.[0]?.finish_reason;
    if (typeof finish === "string") { parts.push(`finish_reason: ${finish}`); truncated = finish === "length"; }
    if (typeof payload.usage?.completion_tokens === "number") parts.push(`completion_tokens: ${payload.usage.completion_tokens}`);
    const thinking = payload.usage?.completion_tokens_details?.reasoning_tokens;
    if (typeof thinking === "number") parts.push(`reasoning_tokens: ${thinking}`);
  }
  return { text: parts.join(", "), truncated };
}

function extractChatText(payload: ChatPayload): string | null {
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function classify(status: number, message: string): ErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return /credit|quota|billing|insufficient|exhausted/i.test(message) ? "quota" : "rate_limit";
  if (status === 404 || (status === 400 && /model/i.test(message))) return "model";
  return "provider";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function sendOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) throw new SimulationError(failureMessages.timeout, 504, "timeout");
    throw new SimulationError(failureMessages.network, 502, "network", error instanceof Error ? error.message : undefined);
  }
  finally { clearTimeout(timer); }
}

export async function complete(config: ModelConfig, request: CompletionRequest): Promise<string> {
  const provider = getProvider(config.providerId);
  if (!provider) throw new SimulationError("ספק ה־AI שנבחר אינו מוכר.", 400, "config");
  if (!config.apiKey) throw new SimulationError("לא הוגדר מפתח AI.", 503, "config");
  config.beforeCall?.();
  const model = resolveModel(config, provider, request.role);
  if (config.maxOutputTokens) request = { ...request, maxOutputTokens: Math.min(request.maxOutputTokens, config.maxOutputTokens) };
  const responses = provider.protocol === "openai-responses";
  const url = `${provider.baseUrl}${responses ? "/responses" : "/chat/completions"}`;
  const body = responses ? buildResponsesBody(provider, model, request) : buildChatBody(provider, model, request);
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body) };
  const timeoutMs = config.timeoutMs ?? 60000;

  // One automatic retry for a dropped connection or a provider-side (5xx) failure. Auth, quota and
  // rate-limit errors are not retried: repeating them cannot help and would spend more of the quota.
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 2 && !response; attempt += 1) {
    try {
      const candidate = await sendOnce(url, init, timeoutMs);
      if (candidate.status >= 500 && attempt === 1) { await sleep(config.retryDelayMs ?? 1500); continue; }
      response = candidate;
    } catch (error) {
      if (!(error instanceof SimulationError) || error.kind !== "network" || attempt === 2) throw error;
      await sleep(config.retryDelayMs ?? 1500);
    }
  }
  if (!response) throw new SimulationError(failureMessages.provider, 502, "provider");

  const payload = await response.json().catch(() => ({})) as OpenAIResponsesPayload & ChatPayload;
  const output = responses ? extractOpenAIText(payload) : extractChatText(payload);
  const reply = describeReply(payload, responses);
  // A structured (JSON) answer that was cut off is unusable even though some text arrived.
  const cutOffJson = Boolean(output) && reply.truncated && Boolean(request.json);
  if (!response.ok || !output || cutOffJson) {
    const providerMessage = responses ? extractOpenAIError(payload) : typeof payload.error?.message === "string" ? payload.error.message : null;
    const detail = providerMessage || `לא התקבלה תשובה קריאה${reply.text ? ` (${reply.text})` : ""}`;
    const kind: ErrorKind = response.ok ? (reply.truncated ? "truncated" : "bad_response") : classify(response.status, detail);
    throw new SimulationError(failureMessages[kind as keyof typeof failureMessages] ?? failureMessages.provider, 502, kind, `${provider.name} (${response.status}): ${detail}`);
  }
  return output;
}

/** Sends one very short request so a teacher can check that the provider, model and key work. */
export async function testConnection(config: ModelConfig): Promise<void> {
  try {
    await complete({ ...config, beforeCall: undefined, maxOutputTokens: undefined }, { role: "response", system: "ענה במילה אחת בלבד.", user: "אמור: בסדר", maxOutputTokens: 256 });
  } catch (error) {
    // The teacher sees the provider's own wording as well, to tell a wrong key from a missing model.
    if (error instanceof SimulationError && error.detail) throw new SimulationError(`${error.message} (פרטי הספק: ${error.detail})`, error.status, error.kind, error.detail);
    throw error;
  }
}
