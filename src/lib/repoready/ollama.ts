import type { ModelHealth } from "./types.ts";

export class OllamaError extends Error {
  code: "unavailable" | "timeout" | "malformed" | "http";

  constructor(code: OllamaError["code"], message: string) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
  }
}

export type OllamaConfig = { baseUrl: string; model: string; timeoutMs: number };

export function ollamaConfig(): OllamaConfig {
  const timeout = Number(process.env.OLLAMA_TIMEOUT_MS ?? 45_000);
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    model: process.env.OLLAMA_MODEL ?? "qwen3:4b",
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000,
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function modelListed(names: string[], wanted: string): boolean {
  return names.some((name) => name === wanted || name.startsWith(`${wanted}:`) || wanted.startsWith(`${name}:`));
}

export async function checkModel(fetchImpl: typeof fetch = fetch): Promise<ModelHealth> {
  const config = ollamaConfig();
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      return {
        available: false,
        model: config.model,
        baseUrl: config.baseUrl,
        detail: `Ollama returned ${response.status}.`,
      };
    }
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (body.models ?? []).flatMap((item) => [item.name, item.model].filter((value): value is string => Boolean(value)));
    if (!modelListed(names, config.model)) {
      return {
        available: false,
        model: config.model,
        baseUrl: config.baseUrl,
        detail: `Ollama is running, but ${config.model} is not pulled.`,
      };
    }
    return {
      available: true,
      model: config.model,
      baseUrl: config.baseUrl,
      detail: `${config.model} is available.`,
    };
  } catch (error) {
    const detail = isTimeout(error) ? "Ollama health check timed out." : "Ollama is not reachable.";
    return { available: false, model: config.model, baseUrl: config.baseUrl, detail };
  }
}

export async function generateText(prompt: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const config = ollamaConfig();
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, prompt, stream: false }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) throw new OllamaError("timeout", "The model request timed out.");
    throw new OllamaError("unavailable", "Ollama is not reachable.");
  }
  if (!response.ok) throw new OllamaError("http", `Ollama returned ${response.status}.`);
  let body: { response?: unknown };
  try {
    body = (await response.json()) as { response?: unknown };
  } catch {
    throw new OllamaError("malformed", "Ollama returned a response that was not JSON.");
  }
  if (typeof body.response !== "string" || body.response.trim().length === 0) {
    throw new OllamaError("malformed", "Ollama returned no text.");
  }
  return body.response.trim();
}
