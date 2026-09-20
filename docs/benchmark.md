# Benchmark

The fourth page answers one question: on this machine, is the engine
faster or slower at an agent's work than it was, or than with another
quantization of the same model? It replays a scripted agent session from
empty caches, keeps what the engine measured, and puts two runs side by
side.

It measures the engine, never the model. No answer is checked, the number
of turns is fixed, and what the model replies is thrown away. Which model
is good at the work is a question for a real agent on a real task.

## The session

Every run sends the same generated conversation: a long system prompt with
twelve tool schemas, then turns that each append a tool call and its result
(a YAML list, a JSON inventory, a file listing). Thinking is on, the
temperature is 1.0, and every turn may generate 256 tokens.

| Preset | Turns | First request | Context at the end |
|---|---|---|---|
| `short` | 4 | 10K tokens | about 16K |
| `agent` | 8 | 15K tokens | about 40K |

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
| Cold | tokenize plus prefill time of the first turn, nothing cached. The engine reports no time to first token per request; this is the closest, without queue time |
| Prefill | prompt tokens per second on the first turn |
| Warm prefill | the same on the later turns, over the tokens that were not cached; a turn that prefilled under 256 tokens is left out |
| Decode | generated tokens per second over the whole session, reasoning included |
| Cache | cached over prompt tokens on the later turns |
| Peak | the engine process footprint at its highest, sampled once a second |

A row opens to the rest: the latency of the warm turns, decode on the
first and on the last turn (the slope with depth), the spread between
repetitions, MLX's peak active memory, and every turn as the engine stated
it. The turns are where a cache problem shows: a `cached` that stops
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
| turn ended early | a turn stopped before 256 tokens, usually at a tool call; it is left out of the first and last decode rates |
| prompt size drifted | the first prompt is over 10% off its target |
| other requests ran | the engine served somebody else during the run |

A suspect run is kept and shown: a cache that does not hold is a finding.

## Comparing

Tick two runs. The second ticked shows its change against the first under
each figure, green when better and amber when worse; under one percent
reads as the same. Runs compare only when they replayed the same session:
the same preset and the same generator, which the script id in the opened
row names.
