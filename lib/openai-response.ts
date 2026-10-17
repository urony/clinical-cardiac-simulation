/**
 * The Responses API returns generated text inside output[].content[].
 * Keep parsing in one place so every future simulation phase handles
 * the API response consistently.
 */
export type OpenAIResponsesPayload = {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{ type?: unknown; text?: unknown }>;
  }>;
  error?: { message?: unknown };
};

export function extractOpenAIText(payload: OpenAIResponsesPayload): string | null {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const parts = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => (content.type === "output_text" || content.type === "text") && typeof content.text === "string")
    .map((content) => (content.text as string).trim())
    .filter(Boolean);

  if (parts.length) return parts.join("\n");

  // Some Responses API model variants return the text in a compatible content
  // object whose type label is not output_text. Accept that shape rather than
  // treating a successful API call as an empty answer.
  const fallback = (payload.output ?? []).flatMap((item) => item.content ?? [])
    .map((content) => typeof content.text === "string" ? content.text.trim() : "")
    .filter(Boolean);
  return fallback.length ? fallback.join("\n") : null;
}

export function extractOpenAIError(payload: OpenAIResponsesPayload): string | null {
  return typeof payload.error?.message === "string" ? payload.error.message : null;
}
