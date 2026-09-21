// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The generated session a benchmark replays: a long system prompt with tool
// schemas, then turns that each append a scripted tool call and its result.
// Pure and seeded, so every model and every run gets the same prompts; only
// the tag differs, and it is what makes the first turn cold.
//
// The trajectory is forced: what the model answers is dropped and the
// scripted message is appended instead. A real client round-trips the
// model's own output, which the cache already holds, so a real agent's
// cache hit rate is a little higher than what this session shows.

import type { BenchmarkPreset } from "../../shared/benchmark.ts";

// bump when the generated text or the sizes change: runs with different
// hashes do not compare
export const GENERATOR = 1;

// the generated text is YAML and JSON heavy; the fit replaces the guess
const CHARS_PER_TOKEN = 2.6;

// what the model may generate and the template's own tokens, kept free
const WINDOW_MARGIN = 2048;

type PresetShape = { first: number; results: number[] };

// token targets: the first request, then one tool result per later turn
const SHAPES: Record<BenchmarkPreset, PresetShape> = {
  "20K": { first: 10_000, results: [2_000, 1_000, 3_000, 4_000] },
  "40K": {
    first: 15_000,
    results: [2_000, 4_000, 1_000, 6_000, 3_000, 8_000, 2_000],
  },
  "60K": {
    first: 20_000,
    results: [2_000, 4_000, 1_000, 6_000, 3_000, 8_000, 2_000, 6_000, 8_000],
  },
};

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type Step = {
  call: { id: string; name: string; arguments: string };
  result: string;
};

export type Session = {
  system: string;
  user: string;
  tools: ToolSchema[];
  steps: Step[];
};

// What the fit measured with the model's own tokenizer: characters per
// token of each generated piece (a JSON inventory tokenizes worse than a
// YAML list, and each tokenizer differs), and the size of the tool schemas.
export type Ratios = {
  system: number;
  results: number[];
  toolTokens: number;
};

export type SessionOptions = {
  preset: BenchmarkPreset;
  // unique per repetition; empty for the hash
  tag: string;
  // from the fit; null sizes every piece by the guess
  ratios: Ratios | null;
  // the model's context window, null when the engine did not say
  window: number | null;
  maxTokens: number;
};

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ChatBody = {
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  max_tokens: number;
  temperature: number;
  top_p: number;
  enable_thinking: boolean;
  stream: false;
};

export function turnsOf(preset: BenchmarkPreset): number {
  return SHAPES[preset].results.length + 1;
}

// The token targets of a preset, shrunk together when the whole session
// would not fit the model's window.
export function targetsOf(
  preset: BenchmarkPreset,
  window: number | null,
  maxTokens: number,
): PresetShape {
  const shape = SHAPES[preset];
  const total = shape.first + shape.results.reduce((a, b) => a + b, 0);
  const room = window === null ? total : window - maxTokens - WINDOW_MARGIN;
  if (room >= total) return shape;
  const k = Math.max(room, 0) / total;
  return {
    first: Math.floor(shape.first * k),
    results: shape.results.map((n) => Math.floor(n * k)),
  };
}

// The texts the fit tokenizes, in the order ratiosOf() reads the counts:
// the system prompt, the tool schemas, then every tool result.
export function piecesOf(session: Session): string[] {
  return [
    session.system,
    JSON.stringify(session.tools),
    ...session.steps.map((s) => s.result),
  ];
}

// Bounded: a wild ratio means the tokenizer answered nonsense, not that
// the text is unusual.
export function ratiosOf(session: Session, tokens: number[]): Ratios {
  const pieces = piecesOf(session);
  const ratio = (i: number) => {
    const n = tokens[i] ?? 0;
    const r = n > 0 ? pieces[i]!.length / n : CHARS_PER_TOKEN;
    return Math.min(Math.max(r, 1), 8);
  };
  return {
    system: ratio(0),
    results: session.steps.map((_, i) => ratio(i + 2)),
    toolTokens: tokens[1] ?? 0,
  };
}

export function buildSession(opts: SessionOptions): Session {
  const targets = targetsOf(opts.preset, opts.window, opts.maxTokens);
  const r = opts.ratios;
  const rand = mulberry32(0x1c7b);
  const tools = TOOLS.map(toolSchema);
  const toolTokens =
    r?.toolTokens ?? JSON.stringify(tools).length / CHARS_PER_TOKEN;
  const head = opts.tag ? `[bench ${opts.tag}] ` : "";
  const systemChars = Math.floor(
    Math.max(targets.first - toolTokens, 150) * (r?.system ?? CHARS_PER_TOKEN),
  );
  const system = head + systemPrompt(rand, systemChars);
  const steps = targets.results.map((tokens, i) => {
    const tool = TOOLS[(i * 5 + 2) % TOOLS.length]!;
    return {
      call: {
        id: `call_${i + 1}`,
        name: tool.name,
        arguments: JSON.stringify(tool.args(rand)),
      },
      result: RESULTS[i % RESULTS.length]!(
        rand,
        Math.floor(tokens * (r?.results[i] ?? CHARS_PER_TOKEN)),
      ),
    };
  });
  return { system, user: USER, tools, steps };
}

// The request of one turn: turn 1 is the cold one, turn n carries n - 1
// scripted calls and their results.
export function requestFor(
  session: Session,
  turn: number,
  model: string,
  maxTokens: number,
): ChatBody {
  const messages: ChatMessage[] = [
    { role: "system", content: session.system },
    { role: "user", content: session.user },
  ];
  for (const step of session.steps.slice(0, turn - 1)) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: step.call.id,
          type: "function",
          function: { name: step.call.name, arguments: step.call.arguments },
        },
      ],
    });
    messages.push({
      role: "tool",
      tool_call_id: step.call.id,
      content: step.result,
    });
  }
  return {
    model,
    messages,
    tools: session.tools,
    max_tokens: maxTokens,
    temperature: 1.0,
    top_p: 0.95,
    enable_thinking: true,
    stream: false,
  };
}

// Identifies the workload: the generator, the preset's sizes and the text.

const USER =
  "Audit the delivery pipeline of this cluster: list what is deployed, " +
  "trace each workload to the source that manages it, and write the " +
  "findings to audit.json. Use the tools; do not guess.";

type Rand = () => number;

function mulberry32(seed: number): Rand {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: Rand, from: readonly T[]): T {
  return from[Math.floor(rand() * from.length)]!;
}

const NAMESPACES = ["apps", "infra", "monitoring", "ingress", "data", "ci"];
const APPS = [
  "frontend",
  "backend",
  "gateway",
  "worker",
  "scheduler",
  "cache",
  "ledger",
  "notifier",
  "indexer",
  "billing",
];
const KINDS = ["Deployment", "StatefulSet", "DaemonSet", "CronJob"];
const REGISTRIES = [
  "registry.example.com",
  "ghcr.io/example",
  "quay.io/example",
];
const TOPICS = [
  "source control",
  "reconciliation",
  "dependency ordering",
  "health checks",
  "drift detection",
  "secrets handling",
  "image promotion",
  "rollback",
  "multi-tenancy",
  "change review",
];
const VERBS = [
  "inspect",
  "compare",
  "verify",
  "trace",
  "record",
  "report",
  "confirm",
  "reject",
];

type ToolSpec = {
  name: string;
  about: string;
  params: Record<string, string>;
  args: (rand: Rand) => Record<string, string>;
};

const nsArgs = (rand: Rand) => ({ namespace: pick(rand, NAMESPACES) });

const TOOLS: ToolSpec[] = [
  {
    name: "list_resources",
    about: "List the resources of a kind, optionally inside one namespace",
    params: { kind: "the resource kind", namespace: "the namespace" },
    args: (rand) => ({ kind: pick(rand, KINDS), ...nsArgs(rand) }),
  },
  {
    name: "get_resource",
    about: "Read one resource with its spec and status as YAML",
    params: { kind: "the kind", name: "the name", namespace: "the namespace" },
    args: (rand) => ({
      kind: pick(rand, KINDS),
      name: pick(rand, APPS),
      ...nsArgs(rand),
    }),
  },
  {
    name: "trace_resource",
    about: "Walk up from a resource to the objects that manage it",
    params: { kind: "the kind", name: "the name", namespace: "the namespace" },
    args: (rand) => ({
      kind: "Deployment",
      name: pick(rand, APPS),
      ...nsArgs(rand),
    }),
  },
  {
    name: "get_events",
    about: "Read the recent events of a namespace, newest first",
    params: { namespace: "the namespace", since: "a duration such as 1h" },
    args: (rand) => ({ ...nsArgs(rand), since: "1h" }),
  },
  {
    name: "get_logs",
    about: "Read the last lines of a workload's logs",
    params: { name: "the workload", namespace: "the namespace" },
    args: (rand) => ({ name: pick(rand, APPS), ...nsArgs(rand) }),
  },
  {
    name: "list_sources",
    about: "List the sources the cluster pulls from with their revisions",
    params: { namespace: "the namespace" },
    args: nsArgs,
  },
  {
    name: "get_api_versions",
    about: "List the API groups, kinds and versions the cluster serves",
    params: {},
    args: () => ({}),
  },
  {
    name: "read_file",
    about: "Read a file from the working directory",
    params: { path: "the path, relative to the working directory" },
    args: (rand) => ({ path: `clusters/dev/${pick(rand, APPS)}.yaml` }),
  },
  {
    name: "list_files",
    about: "List the files under a directory, recursively",
    params: { path: "the directory" },
    args: () => ({ path: "clusters/dev" }),
  },
  {
    name: "write_file",
    about: "Write a file in the working directory, replacing it",
    params: { path: "the path", content: "the whole new content" },
    args: () => ({ path: "audit.json", content: "{}" }),
  },
  {
    name: "search_schema",
    about: "Search the schema catalog for a kind and return its fields",
    params: { kind: "the kind", field: "a field path to narrow the answer" },
    args: (rand) => ({ kind: pick(rand, KINDS), field: "spec" }),
  },
  {
    name: "get_inventory",
    about: "Read the inventory of objects a manager applied, as JSON",
    params: { name: "the manager", namespace: "the namespace" },
    args: (rand) => ({ name: pick(rand, APPS), ...nsArgs(rand) }),
  },
];

function toolSchema(tool: ToolSpec): ToolSchema {
  const properties: Record<string, unknown> = {};
  for (const [name, description] of Object.entries(tool.params)) {
    properties[name] = { type: "string", description };
  }
  return {
    type: "function",
    function: {
      name: tool.name,
      description: `${tool.about}. Read-only unless the name says write.`,
      parameters: {
        type: "object",
        properties,
        required: Object.keys(tool.params).slice(0, 1),
      },
    },
  };
}

function systemPrompt(rand: Rand, chars: number): string {
  const out = [
    // a model that cannot follow this is no use, and the runner checks it
    "You are an operations agent working on a GitOps managed cluster. " +
      "Respond only in English. " +
      "Answer from what the tools return and keep a record of every step.",
  ];
  let size = out[0]!.length;
  for (let section = 1; size < chars; section++) {
    const topic = pick(rand, TOPICS);
    const lines = [`## ${section}. Rules for ${topic}`];
    for (let rule = 1; rule <= 6; rule++) {
      lines.push(
        `${section}.${rule} Before you ${pick(rand, VERBS)} ${topic} in the ` +
          `${pick(rand, NAMESPACES)} namespace, ${pick(rand, VERBS)} the ` +
          `${pick(rand, KINDS)} named ${pick(rand, APPS)} and ` +
          `${pick(rand, VERBS)} its revision against ${pick(rand, REGISTRIES)}.`,
      );
    }
    lines.push("```yaml", workload(rand, section), "```");
    const text = lines.join("\n");
    out.push(text);
    size += text.length + 2;
  }
  return out.join("\n\n").slice(0, chars);
}

function workload(rand: Rand, i: number): string {
  const app = pick(rand, APPS);
  const tag = `${1 + Math.floor(rand() * 4)}.${Math.floor(rand() * 20)}.${i}`;
  return [
    "- apiVersion: apps/v1",
    `  kind: ${pick(rand, KINDS)}`,
    "  metadata:",
    `    name: ${app}-${i}`,
    `    namespace: ${pick(rand, NAMESPACES)}`,
    "    labels:",
    `      app.kubernetes.io/name: ${app}`,
    `      app.kubernetes.io/version: ${tag}`,
    "  spec:",
    `    replicas: ${1 + Math.floor(rand() * 5)}`,
    `    image: ${pick(rand, REGISTRIES)}/${app}:${tag}`,
    "  status:",
    `    readyReplicas: ${Math.floor(rand() * 5)}`,
    `    observedGeneration: ${10 + Math.floor(rand() * 90)}`,
  ].join("\n");
}

function fill(chars: number, next: (i: number) => string, sep: string) {
  const out: string[] = [];
  let size = 0;
  for (let i = 1; size < chars; i++) {
    const item = next(i);
    out.push(item);
    size += item.length + sep.length;
  }
  return out.join(sep).slice(0, chars);
}

// The shapes a tool answers in: a YAML list, a JSON inventory, a listing.
const RESULTS: ((rand: Rand, chars: number) => string)[] = [
  (rand, chars) => fill(chars, (i) => workload(rand, i), "\n"),
  (rand, chars) =>
    fill(
      chars,
      (i) =>
        JSON.stringify({
          id: `${pick(rand, NAMESPACES)}_${pick(rand, APPS)}-${i}_apps_${pick(rand, KINDS)}`,
          version: "v1",
          managedBy: `Kustomization/${pick(rand, NAMESPACES)}/${pick(rand, APPS)}`,
          revision: `main@sha1:${Math.floor(rand() * 0xffffffff).toString(16)}`,
          ready: rand() > 0.2,
        }),
      ",\n",
    ),
  (rand, chars) =>
    fill(
      chars,
      (i) =>
        `clusters/dev/${pick(rand, NAMESPACES)}/${pick(rand, APPS)}-${i}/` +
        `${pick(rand, ["kustomization", "release", "source", "values"])}.yaml` +
        `  ${200 + Math.floor(rand() * 9000)} bytes`,
      "\n",
    ),
];
