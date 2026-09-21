# Models

The Models page (`/models`, under Engine in the rail) is what is on this
machine, what each model is, and what is on its way.

## Download

A repository from the Hugging Face Hub, as `owner/name` or a
huggingface.co URL, goes into `--model-dir` (`~/models` by default) as
`<owner>/<name>/`. A refusal (no such repository, a gated one without
`hf.key`, one already downloading) shows under the field.

The downloads sit under the form, one at a time from a queue: the bytes
of the total, the speed, the file in flight and the percent while one
runs, `queued` while it waits, the error when it failed, `paused` when it
was stopped. Pause keeps the parts on disk and Resume carries on from
them; Delete removes the files and the record. A finished download leaves
the list once the engine lists the model, after the rescan it is asked
for. [The API](api.md#downloads) has the details.

## The list

Every model the engine lists, in the order of the name after the owner.
The search matches the id and the model type; All, Loaded and Unloaded
filter by residency. A row is the name, then a faint line: a star for the
daily driver, the owner, the bits, the active parameters of a mixture of
experts, and the state when it is not plain unloaded (`loaded`,
`loading`, `deleted`). The figures are the parameters, the context the
engine serves and the size on disk; the head counts the models on disk
and their size.

A row opens to what is known of the model:

- **Architecture**: the model type, the parameters (and the active ones),
  the layers (with the full and linear attention split of a hybrid), the
  hidden size, the attention heads with the KV heads and the head size,
  the vocabulary.
- **Experts**, for a mixture of experts only: routed, per token, shared.
- **Context**: the window the engine serves, the model's own maximum, the
  MTP layers, and while the model is resident whether the engine runs
  them (`in use` or `off`).
- **Weights**: the bits and the quantization mode, the group size, the
  dtype, the size on disk, the safetensors file count.
- **Sampling defaults**: temperature, top p and top k.
- **Source**: the revision and the date of the download that brought it,
  and the license from the model card. A model this program has no
  download record of (copied in, or its record wiped with the database)
  shows the date of its `config.json` and no revision.
- **Capabilities** as the engine reports them, then the input types.

Under the panel: the model card on the Hub, Delete (a local engine only,
and not while the model is resident), the daily driver star, and Load or
Unload. They are the Overview's actions, with the same confirmations. A
deleted model keeps its row, its buttons off, until the engine restarts.

## Where the figures come from

Two sources, neither of them a new request to the engine:

- **The engine's model list**, which is polled anyway: the context it
  serves, the capabilities and the input types, the sampling it applies,
  and a few facts of the checkpoint (type, layers, hidden size,
  vocabulary, whether it is a mixture of experts). This is all a remote
  engine's models show.
- **The checkpoint**, when the engine is on this host and the model is
  under `--model-dir`: `config.json`, `generation_config.json`, the model
  card's front matter, and the headers of the safetensors files, never
  the tensors. The parameter count is exact, counted from the tensors'
  shapes (a quantized weight is unpacked by its scales and group size); a
  mixture's active count takes the routed experts at the per-token share,
  and an output projection tied to the embedding is not counted twice.
  A model is read once, then again when one of those files changes. A
  symlinked file or directory is not read, and the reads are bounded: a
  config over 4 MB, a header over 64 MB or headers over 256 MB together
  give no figure rather than a slow page.

The checkpoint wins for what the model is, the engine for what it
serves. A figure neither states is a dash.
