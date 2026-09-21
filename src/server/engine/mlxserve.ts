// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// Adapter for mlx-serve (github.com/ddalcu/mlx-serve) in --serve mode.
//
// The sampler uses only endpoints that mlx-serve's dispatch answers before
// its model-load step: /health, /metrics.json, /v1/models and, after a
// download, /v1/models/rescan (verified in the engine's src/server.zig). GET
// /props goes through the load path and cold-loads the default model on an
// idle engine, which is the bug that motivated 1ctx-mlx-engine, so props() is
// asked only while a model is resident and then only once per engine process.
// load/unload are explicit user actions, never called from the sampler.
// chat() and tokenize() are the benchmark's: /v1/chat/completions and
// /tokenize, only from a button, only under the shared lock; chat() is the
// one call here that makes the engine work.

import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineConfig } from "../../shared/engine.ts";
import type { Capability, ModelInfo } from "../../shared/models.ts";
import type {
  ChatAnswer,
  ChatTimings,
  Engine,
  EngineMetrics,
  EngineModelMeta,
  EngineProps,
  HistogramSummary,
} from "./types.ts";

// Every request from the sampler must fail fast: a hung engine must not
// stall the 1 Hz loop, and a sample with engineUp=false is the right answer.
const TIMEOUT_MS = 3000;
// Loads can take seconds (mmap of tens of GB); unloads a few seconds too.
const ACTION_TIMEOUT_MS = 120_000;

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

function hist(v: any): HistogramSummary {
  return { count: num(v?.count), sum: num(v?.sum) };
}

// Pure: the /metrics.json body → normalised metrics. Exported for tests.
export function parseMetrics(body: any): EngineMetrics {
  const c = body?.counters ?? {};
  const g = body?.gauges ?? {};
  const h = body?.histograms ?? {};
  return {
    counters: {
      promptTokens: num(c.prompt_tokens_total),
      prefillTokens: num(c.prefill_tokens_total),
      cachedPromptTokens: num(c.prefix_cache_tokens_total),
      generationTokens: num(c.generation_tokens_total),
      requestsSuccess: num(c.requests_success_total),
      requestsCancelled: num(c.requests_cancelled_total),
      cacheQueries: num(c.prefix_cache_queries_total),
      cacheHits: num(c.prefix_cache_hits_total),
    },
    gauges: {
      requestsRunning: num(g.requests_running),
      requestsWaiting: num(g.requests_waiting),
      requestsPrefilling: num(g.requests_prefilling),
      gpuPct: num(g.gpu_utilization_pct),
      // memory_mb is the process footprint in MiB
      memoryBytes: num(g.memory_mb) * 1024 * 1024,
      generationTokensLive: num(g.generation_tokens_live),
      prefillTokensLive: num(g.prefill_tokens_live),
      mlxActiveBytes: num(g.mlx_active_bytes),
      mlxCacheBytes: num(g.mlx_cache_bytes),
    },
    histograms: {
      ttftSeconds: hist(h.time_to_first_token_seconds),
      e2eLatencySeconds: hist(h.e2e_request_latency_seconds),
      prefillTimeSeconds: hist(h.prefill_time_seconds),
      decodeTimeSeconds: hist(h.decode_time_seconds),
      promptTokens: hist(h.prompt_tokens),
      outputTokens: hist(h.output_tokens),
    },
  };
}

// Pure: the /v1/models body → ModelInfo[]. Exported for tests. mlx-serve does
// not say which model is the default, so isDefault stays undefined.
export function parseModels(body: any): ModelInfo[] {
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  return data
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id,
      loaded: m.loaded === true,
      state:
        typeof m.state === "string" ? m.state : m.loaded ? "ready" : "unloaded",
      bytesResident: num(m.bytes_resident),
      bytesOnDisk: num(m.bytes_on_disk),
      contextLength:
        typeof m.context_length === "number" ? m.context_length : null,
      quantization:
        typeof m.meta?.quantization === "string" ? m.meta.quantization : null,
      capabilities: Array.isArray(m.capabilities)
        ? m.capabilities.filter((c: unknown) => typeof c === "string")
        : [],
    }));
}

const numOrNull = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

// Pure: the /v1/models body → each model's meta, by id. Exported for tests.
export function parseModelMeta(body: any): Map<string, EngineModelMeta> {
  const data: any[] = Array.isArray(body?.data) ? body.data : [];
  const out = new Map<string, EngineModelMeta>();
  for (const m of data) {
    if (typeof m?.id !== "string") continue;
    const meta = typeof m.meta === "object" && m.meta !== null ? m.meta : {};
    out.set(m.id, {
      architecture:
        typeof meta.architecture === "string" ? meta.architecture : null,
      layers: numOrNull(meta.num_layers),
      hiddenSize: numOrNull(meta.hidden_size),
      vocab: numOrNull(meta.vocab_size),
      maxTokens: numOrNull(meta.model_max_tokens),
      isMoe: typeof meta.is_moe === "boolean" ? meta.is_moe : null,
      mtpLoaded: typeof meta.mtp_loaded === "boolean" ? meta.mtp_loaded : null,
      temperature: numOrNull(meta.gen_temperature),
      topP: numOrNull(meta.gen_top_p),
      topK: numOrNull(meta.gen_top_k),
      inputs: Array.isArray(m.input_modalities)
        ? m.input_modalities.filter((i: unknown) => typeof i === "string")
        : [],
    });
  }
  return out;
}

// Pure: a /v1/chat/completions answer → what the engine measured. The
// llama.cpp-style `timings` object is on the chat path only (not on
// /v1/completions); an answer without it cannot be benchmarked. Exported
// for tests.
export function parseTimings(body: any): ChatTimings {
  const t = body?.timings;
  if (typeof t !== "object" || t === null) {
    throw new Error("/v1/chat/completions: no timings");
  }
  // a missing figure read as 0 would end as a wrong rate, not as an error
  const field = (name: string): number => {
    const value = t[name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`/v1/chat/completions: bad timings.${name}`);
    }
    return value;
  };
  const finish = body?.choices?.[0]?.finish_reason;
  return {
    promptN: field("prompt_n"),
    cachedN: field("cached_n"),
    promptMs: field("prompt_ms"),
    predictedN: field("predicted_n"),
    predictedMs: field("predicted_ms"),
    tokenizeMs: field("tokenize_ms"),
    finishReason: typeof finish === "string" ? finish : null,
  };
}

// Pure: what the model wrote in a /v1/chat/completions answer: its prose,
// the reasoning then the content, and its tool calls, each as its name and
// arguments. Exported for tests.
export function parseOutput(body: any): { prose: string; tools: string } {
  const message = body?.choices?.[0]?.message ?? {};
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const lines = (parts: string[]) =>
    parts.filter((part) => part.trim() !== "").join("\n");
  return {
    prose: lines([text(message.reasoning_content), text(message.content)]),
    tools: lines(
      calls.map(
        (c: any) =>
          `${text(c?.function?.name)} ${text(c?.function?.arguments)}`,
      ),
    ),
  };
}

// an engine's error body goes into an action's or a run's error, which is
// stored and shown: its message, never a page of it
const ERROR_BODY_CHARS = 200;

// Pure: the /props body → the facts worth keeping. The engine reports much
// more (the loaded model's shape, live memory headroom, speculative decoding
// settings), but only these two are unavailable elsewhere and constant for
// the life of the process. Exported for tests.
export function parseProps(body: any): EngineProps {
  const st = body?.settings ?? {};
  const pc = st.prefix_cache ?? {};
  const version = typeof st.version === "string" ? st.version : null;
  const limits =
    typeof pc.mem_bytes === "number" && typeof pc.disk_bytes === "number"
      ? { hotBytes: pc.mem_bytes, diskBytes: pc.disk_bytes }
      : null;
  return { version, limits };
}

export type MlxServeOptions = {
  managed?: () => boolean;
  config?: () => EngineConfig | null;
  home?: string;
};

export class MlxServe implements Engine {
  readonly id = "mlxserve" as const;
  readonly url: string;
  private meta = new Map<string, EngineModelMeta>();

  constructor(
    url: string,
    private readonly options: MlxServeOptions = {},
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(this.url + path, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(this.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ACTION_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${path}: HTTP ${res.status} ${text.slice(0, ERROR_BODY_CHARS)}`.trim(),
      );
    }
  }

  async health(): Promise<boolean> {
    try {
      const j = await this.get("/health");
      return j?.status === "ok";
    } catch {
      return false;
    }
  }

  // A 200 with the wrong shape (a proxy page, a half-written body) is an
  // error, not an empty list or zeroed counters: the latter would drop the
  // favorite and fake a counter reset.
  async models(): Promise<ModelInfo[]> {
    const body = await this.get("/v1/models");
    if (!Array.isArray(body?.data)) throw new Error("/v1/models: no data");
    this.meta = parseModelMeta(body);
    return parseModels(body);
  }

  modelMeta(): ReadonlyMap<string, EngineModelMeta> {
    return this.meta;
  }

  async metrics(): Promise<EngineMetrics> {
    const body = await this.get("/metrics.json");
    if (
      typeof body?.counters !== "object" ||
      typeof body?.gauges !== "object"
    ) {
      throw new Error("/metrics.json: no counters");
    }
    return parseMetrics(body);
  }

  // The only endpoint that states the engine's build and the budgets of the
  // running process, and the only source of either for a remote engine. It
  // also runs the model-load path, so the caller must have seen a model
  // resident first (rule 1): the engine then has nothing to cold-load.
  async props(): Promise<EngineProps | null> {
    try {
      return parseProps(await this.get("/props"));
    } catch {
      return null;
    }
  }

  // Model ids are "<org>/<name>" in serve mode; callers pass the full id.
  async load(id: string, asDefault: boolean): Promise<void> {
    await this.post("/v1/load-model", { model: id, default: asDefault });
  }

  async unload(id: string): Promise<void> {
    await this.post("/v1/unload-model", { model: id });
  }

  // Discovery walks --model-dir at startup only; the rescan absorbs a
  // checkpoint added since. Answered before the model-load step, next to
  // /v1/models in the dispatch (src/server.zig), so it loads nothing.
  async rescan(): Promise<void> {
    await this.post("/v1/models/rescan", {});
  }

  // No timeout of its own: a cold prefill of a long prompt on a large
  // model takes minutes. The caller's signal is the way out, and the engine
  // cancels the slot when the connection drops.
  async chat(body: unknown, signal: AbortSignal): Promise<ChatAnswer> {
    const path = "/v1/chat/completions";
    const res = await fetch(this.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `${path}: HTTP ${res.status} ${text.slice(0, ERROR_BODY_CHARS)}`.trim(),
      );
    }
    const answer = await res.json();
    return { timings: parseTimings(answer), ...parseOutput(answer) };
  }

  // Raw text, no chat template. It runs on the default model, so the
  // caller loads its model as the default first (the engine would otherwise
  // cold-load one, as /props does).
  async tokenize(content: string, signal: AbortSignal): Promise<number> {
    const res = await fetch(`${this.url}/tokenize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    });
    if (!res.ok) throw new Error(`/tokenize: HTTP ${res.status}`);
    const body = (await res.json()) as { tokens?: unknown };
    if (!Array.isArray(body.tokens)) throw new Error("/tokenize: no tokens");
    return body.tokens.length;
  }

  capabilities(): Set<Capability> {
    return new Set([
      "load",
      "unload",
      "default",
      "restart",
      "diskClear",
      "rescan",
      "benchmark",
    ]);
  }

  // The managed marker changes ownership, never merely the presence of a
  // plist. Until activation succeeds, actions keep targeting the old job.
  cacheDirs(): string[] {
    const home = this.options.home ?? homedir();
    return [join(home, ".mlx-serve", "kv-cache")];
  }

  logFile(): string | null {
    const managedPort = this.options.managed?.()
      ? this.options.config?.()?.port
      : null;
    const port = String(managedPort ?? (new URL(this.url).port || "80"));
    const home = this.options.home ?? homedir();
    return join(home, ".mlx-serve", "logs", `mlx-serve-${port}.log`);
  }

  processNames(): string[] {
    return ["mlx-serve"];
  }

  serviceLabel(): string {
    return this.options.managed?.()
      ? "com.stefanprodan.mlx-serve"
      : "com.ddalcu.mlx-serve";
  }
}
