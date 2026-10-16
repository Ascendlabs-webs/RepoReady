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

export type OllamaTarget = { baseUrl?: string; model?: string };

export function normalizeOllamaBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Enter an Ollama URL like http://127.0.0.1:11434.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The Ollama URL must start with http:// or https://.");
  }
  if (url.username || url.password) throw new Error("Do not put a password in the Ollama URL.");
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("The Ollama URL should be only the host and port, such as http://127.0.0.1:11434.");
  }
  if (!isLocalOllamaHost(url.hostname)) {
    throw new Error("Ollama must be on this computer or your local network. A public URL is refused.");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function isLocalOllamaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return false;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function normalizeModelName(raw: string): string {
  const model = raw.trim();
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(model)) {
    throw new Error("The model name should look like qwen3:4b.");
  }
  return model;
}

export function ollamaConfig(target?: OllamaTarget): OllamaConfig {
  const timeout = Number(process.env.OLLAMA_TIMEOUT_MS ?? 45_000);
  const baseUrl = target?.baseUrl?.trim()
    ? normalizeOllamaBaseUrl(target.baseUrl)
    : (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = target?.model?.trim() ? normalizeModelName(target.model) : (process.env.OLLAMA_MODEL ?? "qwen3:4b");
  return {
    baseUrl,
    model,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 45_000,
  };
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function modelListed(names: string[], wanted: string): boolean {
  return names.some((name) => name === wanted || name.startsWith(`${wanted}:`) || wanted.startsWith(`${name}:`));
}

export async function checkModel(fetchImpl: typeof fetch = fetch, target?: OllamaTarget): Promise<ModelHealth> {
  let config: OllamaConfig;
  try {
    config = ollamaConfig(target);
  } catch (error) {
    return {
      available: false,
      model: target?.model?.trim() || "qwen3:4b",
      baseUrl: target?.baseUrl?.trim() || "",
      detail: error instanceof Error ? error.message : "The Ollama URL is not valid.",
    };
  }
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

export async function generateText(
  prompt: string,
  fetchImpl: typeof fetch = fetch,
  target?: OllamaTarget,
): Promise<string> {
  const config = ollamaConfig(target);
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
