# Benchmark

The two pages under Benchmark in the rail answer one question: on this
machine, is the engine faster or slower at an agent's work than it was, or
than with another quantization of the same model? Run (`/benchmark`)
replays a scripted agent session from empty caches, keeps what the engine
measured, and puts two runs side by side. The Scorecard
(`/benchmark/scorecard`) ranks the models by their newest run.

It measures the engine, never the model. No answer is checked for being
right, the number of turns is fixed, and what the model replies is thrown
away once it has been looked at for two things: a model that does not work
at all (no text, text that does not decode, noise, a loop), because it
decodes as fast as one that does, and a model that does not answer in
English, the one rule the session gives it. Which model is good at the work is a
question for a real agent on a real task.

## The session

Every run sends the same generated conversation: a long system prompt that
asks for answers in English, with twelve tool schemas, then turns that each append a tool call and its result
(a YAML list, a JSON inventory, a file listing). Thinking is on, the
temperature is 1.0, and every turn may generate 256 tokens.

| Preset | Turns | First request | Context at the end |
|---|---|---|---|
| `20K` | 5 | 10K tokens | about 20K |
| `40K` | 8 | 15K tokens | about 40K |
| `60K` | 10 | 20K tokens | about 60K |

The sizes are in tokens of the model under test: before the run, every
piece is counted with the model's own tokenizer and sized to its target. A
model with a smaller context window gets the same session shrunk to fit.

The conversation is forced: the scripted tool call is appended whatever the
model answered. That is what makes two models comparable, and it costs a
little realism: a real client sends the model's own reply back, which the
cache already holds, so a real agent's cache hit rate is slightly higher.

## A run

Run asks first, because it is rough on the engine: it restarts three times,
every model is unloaded and the SSD cache tier is deleted. The button is
off unless the engine runs on this host, was installed from the Engine
page, is up and idle, and no download is running. While a run is in
progress every other action waits, downloads included, and the card shows
the phase, the repetition and the turn, with a Cancel that stops the
request in flight.

Each of the three repetitions starts from nothing: restart, delete the
cache tier, load the model as the default, one discarded request to pay
for the first Metal compile, then the turns. The first turn of each has a
unique tag at the start of its prompt, so nothing of it can be cached. The
model stays loaded at the end.

## The numbers

Each figure is the median of the three repetitions.

| Column | What it is |
|---|---|
| Latency | tokenize plus prefill time of the first turn, nothing cached: how long a new session waits. The engine reports no time to first token per request; this is the closest, without queue time |
| Prefill | prompt tokens per second on the first turn |
| Warm prefill | the same on the later turns, over the tokens that were not cached; a turn that prefilled under 256 tokens is left out |
| Decode | generated tokens per second over the whole session, reasoning included |

A card too narrow for every column (a phone, or a tablet beside the
rail) keeps Prefill and Decode, and under the model the preset in place of
the date.

The top of the runs card is a search: what is typed narrows the runs to
the models whose id holds it, in any case, so `35B` finds every 35B model.
Escape clears it. Beside it, All, 20K, 40K and 60K narrow the runs to a
preset.

A row opens to every figure the run has, the ones a phone leaves out of
the row included, under the model and why the run is suspect, if it is:

| Group | What |
|---|---|
| Latency | the cold turn and the warm turns |
| Prefill | cold and warm, and the cache hit: the share of the later turns' prompt tokens that came from the cache |
| Decode | over the session, on the first turn and on the last (the slope with depth) |
| Memory | the engine process footprint at its highest (sampled once a second) and MLX's peak active memory, both from the first restart on, and the host's memory |
| Workload | the preset, turns times repetitions, the tokens a turn may generate, the first prompt, the context at the end |
| Setup | the engine build, the chip, the OS, how long the run took, when it started |

Each figure carries its spread between repetitions: half the distance from
the slowest to the fastest, as a share of the median. Under the groups are
the engine's arguments that tune it (serve mode, the listen address and the
model and log locations are left out, here and in the report), then every
turn as the engine stated it. The turns are where a cache problem shows: a `cached` that stops
growing from one turn to the next is a hot cache budget too small for the
session. Copy report puts all of it on the clipboard as plain text.

With mlx-serve 26.9 and a Qwen3 chat template, the second turn misses
from the tool schemas on, by about their size: it is the first request
with tool messages in it, and the prompt renders differently from there.
An agent session pays that once.

## Suspect runs

A finished run is tagged `suspect`, with the reasons in the opened row,
when its numbers should not be trusted as they stand:

| Reason | Meaning |
|---|---|
| cold turn hit the cache | the first turn found more cached than the template's opening tokens |
| cache did not hold | a turn from the third on found under 90% of the previous prompt cached |
| little was generated | the run generated under a quarter of what its turns allowed, too little for a decode rate |
| prompt size drifted | the first prompt is over 10% off its target |
| other requests ran | the engine served somebody else during the run |
| output looks broken | a turn's answer was empty though tokens were generated, did not decode, was noise (it barely compressed and held characters that did not decode), or looped (it compressed to under a quarter of its size): the model does not work, however fast |
| did not answer in English | over 5% of the letters of a turn's reasoning and answer were outside the Latin alphabet (Chinese, Japanese, Cyrillic); symbols, emoji and accented letters do not count, nor do tool call arguments, which are data |

A suspect run is kept and shown: a cache that does not hold is a finding.

A turn that stops at a tool call before its 256 tokens is what models do in
a tool session and no reason for suspicion: prefill is untouched, the decode
rate is over the tokens that were generated, and a turn under 64 tokens is
only left out of the first and last turn rates.

## The scorecard

A page of its own, one row per model at a preset, so the fastest model
reads without going through the runs. It opens on `40K`, like the run
card, and 20K, 40K and 60K switch it.

Only the models the engine lists are in it: a model deleted from the
model directory leaves the scorecard, its runs stay in the table. A
model's row is its newest finished run at that preset; a cancelled,
failed or interrupted run is left out, a suspect one is kept and says so.
Only runs of the newest version of the session count: an older one was
over other work. The models differ in script id, since each is sized with
its own tokenizer, and still compare here: they were asked for the same
work in their own tokens.

The rows are ranked by decode. The columns are the runs table's, and under
each figure a bar says how close it comes to the best of its column (for
the latency, the best over this one); the best is green. With a single
model nothing is marked best. A phone keeps Prefill and Decode.

Under the table, **Wait and decode** puts the same runs on a plane: a
dot per model, the wait before a warm turn's answer starts across and the
decode rate up, so the top left starts soonest and writes fastest. That is
the trade an agent lives with, which four columns side by side do not
show at a glance. A model keeps its colour across the presets. A hover on
a dot, or on its line in the legend under the plane, names the model with
both figures; two models on the same spot are both named.

## Comparing

Tick two runs. The second ticked shows its change against the first under
each figure, green when better and amber when worse; under one percent
reads as the same. The head of the table says which against which, the
second ticked vs the first, by model. Only finished runs compare, and only when they replayed
the same session: the same preset, generator and request settings, and the
same sizes, which a model with a small context window shrinks. The script id
in the copied report names all of that.
