# Models

The Models page (`/models`, under Engine in the rail) is what is on this
machine, what each model is, and what is on its way.

## Download

A repository from the Hugging Face Hub, as `owner/name` or a
huggingface.co URL, goes into `--model-dir` (`~/models` by default) as
`<owner>/<name>/`. A refusal (no such repository, a gated one without
`hf.key`, one already downloading) shows under the field.

The downloads sit under the form, one at a time from a queue: the bytes
of the total, the speed and the file in flight with the time left at
the end while one runs, `queued` while it waits, the error when it
failed, `paused` when it was stopped. Pause keeps the parts on disk and
Resume carries on from them; Delete removes the files and the record.
A finished download leaves the list once the engine lists the model,
after the rescan it is asked for. [The API](api.md#downloads) has the
details.

## The list

Every model the engine lists, in the order of the name after the owner.
The search matches the id, the model type and the kind a row shows
(`embed` finds the embedding models); All, Loaded and Unloaded filter by
residency. A row is the name, then a
faint line: the kind for a model that is not for chat, a star for the
daily driver, the owner, the bits (or the dtype of weights that are not
quantized), the active parameters of a mixture of experts, and the state
when it is not plain unloaded (`loaded`, `loading`, `deleted`, or the
engine's reason a load failed, such as `MissingWeight`). The figures are
the parameters, the context and the size on disk; the head counts the
models on disk and their size.

### Kinds of model

mlx-serve serves more than chat models, and the kind comes from the
capabilities it lists, first match wins:

- **Decisions** (`decisions`): a Laya encoder with a decision head that
  answers typed choice, score and yes/no questions about a state on
  `POST /v1/decisions`, one pass, no text generation.
- **Embeddings** (`embeddings`): a model for `POST /v1/embeddings`, the
  retrieval half of RAG. The engine lists Qwen3-Embedding with `chat` too
  and answers a chat request to it with noise, so `embeddings` wins.
- **Chat** (`chat`): everything the Overview, the Requests page and the
  benchmark are about.
- **Media** (`image`, `audio`, `music`, `video`, `3d`): tagged, and kept
  out of the chat paths.

Only a chat model can be the engine's default, the daily driver or a
benchmark's model, and only a chat model is credited with a request: a
load of any other kind loads it beside the default. mlx-serve counts
neither decisions nor embeddings in `/metrics.json`, so they do not show
as requests anywhere.

The Context column is the window the engine serves a chat model, the
longest input of an embedding model and the window a decision model's
state, question and options share.

A row opens to what is known of the model:

- **Architecture**: the model type, the parameters (and the active ones),
  the layers (with the split of a hybrid: full attention, and linear or
  sliding-window attention for the rest), the hidden size, the attention
  heads with the KV heads and the head size, the vocabulary.
- **Experts**, for a mixture of experts only: routed, per token, shared.
- **Context**, for a chat model: the window the engine serves, the
  model's own maximum, and while it is resident the longest context that
  fits in memory now (Fits now, from `/props`), then the MTP layers and
  whether the engine runs them (`in use` or `off`).
- **Decision**, for a decision model: the encoder it was trained on, the
  window, the part of it the options share, and whether its confidences
  were calibrated (temperatures fitted).
- **Embedding**, for an embedding model: the dimensions, the longest
  input and the pooling, when the checkpoint says it.
- **Weights**: the bits and the quantization mode, the group size, the
  dtype, the size on disk, the safetensors file count.
- **Sampling defaults**, for a chat model: temperature, top p and top k.
- **Source**: the revision and the date of the download that brought it,
  and the license from the model card. A model this program has no
  download record of (copied in, or its record wiped with the database)
  shows the date of its `config.json` and no revision.
- **Capabilities** as the engine reports them, then the input types.

Under the panel: the model card on the Hub, Delete (a local engine only,
and not while the model is resident), the daily driver star (a chat model
only), and Load or Unload. They are the Overview's actions, with the same confirmations. A
deleted model keeps its row, its buttons off, until the engine restarts.

## Where the figures come from

Three sources, none of them a new request to the engine:

- **The engine's model list**, which is polled anyway: the context it
  serves, the capabilities and the input types, the sampling it applies,
  and a few facts of the checkpoint (type, layers, hidden size,
  vocabulary, whether it is a mixture of experts). This is all a remote
  engine's models show. A resident decision model's entry is a generic
  stub (a 4096 context, one layer of size 1, "0-bit"), so none of it is
  used; "0-bit" is never shown for any model.
- **`/props`**, which the sampler reads for each resident model with the
  list: the window the process serves and the context that fits now.
- **The checkpoint**, when the engine is on this host and the model is
  under `--model-dir`: `config.json`, `generation_config.json`, the model
  card's front matter, and the headers of the safetensors files, never
  the tensors. A decision checkpoint has no `config.json`: its
  `encoder/config.json` and `rl_agent_config.json` stand in. An embedding
  checkpoint's `sentence_bert_config.json` and `1_Pooling/config.json`
  are read when present. The dtype of weights that are not quantized is
  the headers', which beat a config that says otherwise. The parameter count is exact, counted from the tensors'
  shapes (a quantized weight is unpacked by its scales and group size); a
  mixture's active count takes the routed experts at the per-token share,
  and an output projection tied to the embedding is not counted twice.
  A model is read once, then again when one of those files changes. A
  symlinked file or directory is not read, and the reads are bounded: a
  config over 4 MB, a header over 64 MB or headers over 256 MB together
  give no figure rather than a slow page.

The checkpoint wins for what the model is, the engine for what it
serves. A figure neither states is a dash.
