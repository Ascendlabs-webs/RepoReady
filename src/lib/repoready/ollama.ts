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

export type OllamaTarget = {
  baseUrl?: string;
  model?: string;
  /** Set only by the server from environment variables. Never taken from the browser. */
  hosted?: HostedSettings;
  deployment?: "vercel";
  configError?: string;
};

export type HostedSettings = { baseUrl: string; model: string; apiKey: string; timeoutMs: number };

export const DEFAULT_HOSTED_MODEL = "grok-4.20-0309-non-reasoning";
const DEFAULT_HOSTED_URL = "https://api.x.ai/v1";

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
    throw new Error("The model name contains unsupported characters.");
  }
  return model;
}

export function normalizeHostedBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("MODEL_BASE_URL is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("MODEL_BASE_URL must use https.");
  if (url.username || url.password) throw new Error("Do not put a key in MODEL_BASE_URL.");
  if (url.search || url.hash) throw new Error("MODEL_BASE_URL should not include a query.");
  if (isLocalOllamaHost(url.hostname) || url.hostname.toLowerCase().endsWith(".local")) {
    throw new Error("MODEL_BASE_URL must be a public model API.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function hostedFromEnv(env: NodeJS.ProcessEnv): HostedSettings | null {
  const provider = (env.MODEL_PROVIDER ?? "").trim().toLowerCase();
  if (provider === "ollama") return null;
  const apiKey = (env.MODEL_API_KEY || env.XAI_API_KEY || "").trim();
  const onVercel = env.VERCEL === "1";
  if (provider !== "hosted" && !(onVercel && apiKey)) return null;
  if (!apiKey) return null;
  const timeout = Number(env.MODEL_TIMEOUT_MS ?? 25_000);
  return {
    baseUrl: normalizeHostedBaseUrl(env.MODEL_BASE_URL?.trim() || DEFAULT_HOSTED_URL),
    model: normalizeModelName(env.MODEL_NAME?.trim() || DEFAULT_HOSTED_MODEL),
    apiKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 25_000,
  };
}

/** Local URL fields apply only off Vercel. On Vercel the server model is used. */
export function requestTarget(client: OllamaTarget, env: NodeJS.ProcessEnv = process.env): OllamaTarget {
  const onVercel = env.VERCEL === "1";
  if (!onVercel && client.baseUrl?.trim()) return { baseUrl: client.baseUrl, model: client.model };
  try {
    const hosted = hostedFromEnv(env);
    if (hosted) return { model: hosted.model, hosted };
  } catch (error) {
    return {
      deployment: "vercel",
      model: client.model,
      configError: error instanceof Error ? error.message : "The hosted model is misconfigured.",
    };
  }
  if (onVercel) return { deployment: "vercel", model: (env.MODEL_NAME || DEFAULT_HOSTED_MODEL).trim() };
  return { baseUrl: client.baseUrl, model: client.model };
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
  if (target?.hosted) return checkHosted(fetchImpl, target.hosted);
  if (target?.deployment === "vercel") {
    return {
      available: false,
      provider: "hosted",
      model: target.model?.trim() || DEFAULT_HOSTED_MODEL,
      baseUrl: DEFAULT_HOSTED_URL,
      detail: target.configError || "Ollama cannot run on Vercel. Add XAI_API_KEY in the Vercel project settings and redeploy.",
    };
  }
  let config: OllamaConfig;
  try {
    config = ollamaConfig(target);
  } catch (error) {
    return {
      available: false,
      provider: "ollama",
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
        provider: "ollama",
        model: config.model,
        baseUrl: config.baseUrl,
        detail: `Ollama returned ${response.status}.`,
      };
    }
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string; id?: string }> };
    const names = (body.models ?? []).flatMap((item) =>
      [item.name, item.model, item.id].filter((value): value is string => Boolean(value)),
    );
    if (!modelListed(names, config.model)) {
      return {
        available: false,
        provider: "ollama",
        model: config.model,
        baseUrl: config.baseUrl,
        detail: `Ollama is running, but ${config.model} is not pulled.`,
      };
    }
    return {
      available: true,
      provider: "ollama",
      model: config.model,
      baseUrl: config.baseUrl,
      detail: `${config.model} is available.`,
    };
  } catch (error) {
    const detail = isTimeout(error) ? "Ollama health check timed out." : "Ollama is not reachable.";
    return { available: false, provider: "ollama", model: config.model, baseUrl: config.baseUrl, detail };
  }
}

async function checkHosted(fetchImpl: typeof fetch, hosted: HostedSettings): Promise<ModelHealth> {
  try {
    const response = await fetchImpl(`${hosted.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${hosted.apiKey}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (response.status === 401 || response.status === 403) {
      return {
        available: false,
        provider: "hosted",
        model: hosted.model,
        baseUrl: hosted.baseUrl,
        detail: "The model API key was rejected. Check XAI_API_KEY on Vercel.",
      };
    }
    if (!response.ok) {
      return {
        available: false,
        provider: "hosted",
        model: hosted.model,
        baseUrl: hosted.baseUrl,
        detail: `The model API returned ${response.status}.`,
      };
    }
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const names = (body.data ?? []).map((item) => item.id).filter((value): value is string => Boolean(value));
    if (names.length > 0 && !names.includes(hosted.model)) {
      return {
        available: false,
        provider: "hosted",
        model: hosted.model,
        baseUrl: hosted.baseUrl,
        detail: `${hosted.model} is not on this API. Set MODEL_NAME to one of: ${names.slice(0, 4).join(", ")}.`,
      };
    }
    return {
      available: true,
      provider: "hosted",
      model: hosted.model,
      baseUrl: hosted.baseUrl,
      detail: `${hosted.model} is available on this server.`,
    };
  } catch (error) {
    const detail = isTimeout(error) ? "The model API health check timed out." : "The model API is not reachable.";
    return { available: false, provider: "hosted", model: hosted.model, baseUrl: hosted.baseUrl, detail };
  }
}

export async function generateText(
  prompt: string,
  fetchImpl: typeof fetch = fetch,
  target?: OllamaTarget,
): Promise<string> {
  if (target?.hosted) return generateHosted(prompt, fetchImpl, target.hosted);
  if (target?.deployment === "vercel") {
    throw new OllamaError("unavailable", "No model key is configured on this deployment.");
  }
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

async function generateHosted(prompt: string, fetchImpl: typeof fetch, hosted: HostedSettings): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${hosted.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hosted.apiKey}`,
      },
      body: JSON.stringify({
        model: hosted.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(hosted.timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) throw new OllamaError("timeout", "The model request timed out.");
    throw new OllamaError("unavailable", "The model API is not reachable.");
  }
  if (!response.ok) throw new OllamaError("http", `The model API returned ${response.status}.`);
  let body: { choices?: Array<{ message?: { content?: unknown } }> };
  try {
    body = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  } catch {
    throw new OllamaError("malformed", "The model API returned a response that was not JSON.");
  }
  const content = body.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part === "string" ? part : part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "")).join("")
        : "";
  if (!text.trim()) throw new OllamaError("malformed", "The model API returned no text.");
  return text.trim();
}
