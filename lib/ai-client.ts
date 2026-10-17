import { extractOpenAIError, extractOpenAIText, type OpenAIResponsesPayload } from "./openai-response";

/**
 * Calls the model provider. Today this is OpenAI's Responses API only; stage 4 replaces it with a
 * provider-neutral layer. The browser calls the provider directly, so the key lives only in the
 * page's memory (and, later, in the teacher's class link).
 */
export type ModelConfig = {
  apiKey: string;
  baseUrl?: string;
  models?: { classifier?: string; response?: string; feedback?: string };
};

export const DEFAULT_MODELS = { classifier: "gpt-5.6", response: "gpt-5-mini", feedback: "gpt-5-mini" };
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** An error whose message is safe and meaningful to show to the user. */
export class SimulationError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function modelFor(config: ModelConfig, role: keyof typeof DEFAULT_MODELS) {
  return config.models?.[role] || DEFAULT_MODELS[role];
}

export function apiInput(developer: string, user: string) {
  return [
    { role: "developer", content: [{ type: "input_text", text: developer }] },
    { role: "user", content: [{ type: "input_text", text: user }] },
  ];
}

export async function callModel(config: ModelConfig, body: Record<string, unknown>): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl || DEFAULT_BASE_URL}/responses`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify(body) });
  } catch {
    throw new SimulationError("לא ניתן להגיע לספק ה־AI. בדקו את החיבור לאינטרנט.", 502);
  }
  const payload = await response.json().catch(() => ({})) as OpenAIResponsesPayload;
  const output = extractOpenAIText(payload);
  if (!response.ok || !output) throw new SimulationError(`OpenAI API (${response.status}): ${extractOpenAIError(payload) || "לא התקבלה תשובה קריאה."}`, 502);
  return output;
}
