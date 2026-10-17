import links from "../data/links.json";

/** Link to the API-key wizard for teachers, or null when none is configured. Always https. */
export function wizardLink(): string | null {
  const base = links.wizardUrl as string | null;
  if (!base) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return null;
    url.searchParams.set("tool", links.toolId);
    return url.toString();
  } catch {
    return null;
  }
}
