// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { parseModels } from "../../src/server/engine/mlxserve.ts";
import { isChat, modelKind } from "../../src/shared/models.ts";
import kindsLoaded from "../fixtures/models-kinds-loaded.json";

describe("modelKind", () => {
  test("every model the laptop's engine lists", () => {
    const kinds = Object.fromEntries(
      parseModels(kindsLoaded).map((m) => [m.id, modelKind(m.capabilities)]),
    );
    expect(kinds).toEqual({
      "mlx-community/Qwen3.5-0.8B-4bit": "chat",
      // the engine lists it with chat, and answers a chat with noise
      "mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ": "embedding",
      "mlx-community/bge-small-en-v1.5-bf16": "embedding",
      "aac6fef/laya-multilingual-mlx": "decision",
    });
  });

  test("media, and the rest", () => {
    expect(modelKind(["image"])).toBe("media");
    expect(modelKind(["audio", "streaming"])).toBe("media");
    expect(modelKind(["streaming"])).toBe("other");
    expect(modelKind([])).toBe("other");
    // a chat model that hears is still a chat model
    expect(modelKind(["chat", "audio"])).toBe("chat");
    expect(isChat({ capabilities: ["chat", "vision"] })).toBe(true);
    expect(isChat({ capabilities: ["chat", "embeddings"] })).toBe(false);
  });
});
