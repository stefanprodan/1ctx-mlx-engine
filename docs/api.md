# API

1ctx-mlx-engine serves its pages and a small JSON API from one port (11235 by
default). There is no authentication: the tailnet is the boundary, and the
browser-facing routes check that a request with an `Origin` header comes
from the dashboard's own host. Every JSON response carries
`cache-control: no-store`.

## Pages

| Path | Page |
|---|---|
| `GET /` | Monitor: tiles, charts, models, runtime |
| `GET /requests` | The request in flight and the last 50 finished ones |
| `GET /engine` | 1ctx-mlx-engine's own service, the mlx-serve install and its configuration |
| `GET /benchmark` | Run a benchmark on a model and compare the runs |

## Monitoring

| Route | Answer |
|---|---|
| `GET /api/snapshot` | the latest sample, the model list, the engine's build, capabilities and cache budgets, host facts, the action log, the downloads, the benchmark in progress and the model directory |
| `GET /api/history?range=1h\|6h\|24h\|7d` | columnar series for the charts and the tiles' range totals: rates, cache ratios, TTFT and the token and request counters; 1h is raw seconds, longer ranges are bucket averages |
| `GET /api/requests` | the last 50 finished or cancelled requests, newest first |

`build` is when this 1ctx-mlx-engine binary was compiled (null when run from
source). The page remembers the one it loaded with and reloads itself when
a snapshot carries another: the server was replaced under an open tab, and
`version` cannot say so, since every development build reports the same.

`engine.mode` is what the engine manager makes of the engine: `managed`,
`unmanaged`, `absent` (nothing installed and nothing answering, which the
pages show as not installed) or `remote`; null when there is no manager.

`engine.version` is the engine's build, which it states only while a model
is resident; the answer is kept in 1ctx-mlx-engine's database, so after a
restart with nothing loaded it is the last known build rather than nothing.
Null until the engine has been asked once. `engine.limits` is the pair of
prefix cache budgets, from `--hot-cache-max`/`--disk-cache-max`, the
engine's LaunchAgent plist, or the same answer.

A sample carries the engine state, live decode and prefill tok/s, cache hit
ratios, the memory split (host free, inactive, wired and compressed; engine
footprint and RSS; weights, estimated RAM cache, MLX pool), the cache tier
directories, the model list, and the request in flight or the last one
finished. The engine reports counts, not requests, so with several in
flight the numbers describe the engine as a whole. The memory, host and
disk gauges are live only: the history keeps what the page plots and
totals, not what a tile shows for the current second.

## Actions

`POST /api/actions/<name>` with a JSON body. Every action is checked against
the engine's capabilities and the current model list, runs one at a time,
and is logged. The answer is the log row: `{t, action, model, ok, ms,
detail}`.

| Name | Body | Effect |
|---|---|---|
| `load` | `{"model": "<id>"}` | load a model and make it the engine default |
| `unload` | `{"model": "<id>"}` | unload it; a model still resident becomes the default |
| `default` | `{"model": "<id>"}` | make a model the default, loading it if needed |
| `free` | none | restart the engine service to free its RAM (local engine only) |
| `diskClear` | none | restart, then delete the SSD cache tier contents (local engine only) |
| `historyClear` | none | wipe 1ctx-mlx-engine's own sample history |
| `requestsClear` | none | wipe the stored requests and the last request in the bar; samples are kept |
| `favorite` | `{"model": "<id>"}` | toggle the daily-driver star |

Errors are `{"error": "<sentence>"}` with 400 (bad input), 403
(cross-origin), 404 (unknown model or action), 409 (another action runs) or
501 (the engine lacks the capability or is remote).

## Downloads

1ctx-mlx-engine downloads a model from the Hugging Face Hub itself, into
`--model-dir` (`~/models` by default) as `<owner>/<name>/`,
one download at a time from a queue kept in its database. Every file streams
into `<file>.1ctx-part` and resumes with a Range request after a cut, a retry, a
cancel or a restart of 1ctx-mlx-engine; LFS files are checked against the
Hub's sha256 before the rename. The engine takes no part in the download;
when a download completes 1ctx-mlx-engine asks it to rescan its model
directory, so the model appears in the list when that directory is the one
the engine serves. A gated repository needs `hf.key` in the secrets
directory.

| Route | Body | Answer |
|---|---|---|
| `GET /api/downloads` | | the last 20 downloads, newest first |
| `POST /api/downloads` | `{repo}`: `owner/name` or a huggingface.co URL | 202, the queued download; the same repository again resumes its failed or cancelled download, and answers 409 while one is queued or running |
| `GET /api/downloads/<id>` | | the download |
| `POST /api/downloads/<id>/cancel` | | the download, paused: its parts stay on disk and a new POST for the repository resumes it. 409 when it is not queued or running |
| `DELETE /api/downloads/<id>` | | `{ok: true}`; a running download is stopped first, then its files, partial or finished, and its record are deleted |

A download is `{id, repo, revision, dir, status, bytesTotal, bytesDone,
filesTotal, filesDone, file, error, createdAt, updatedAt, finishedAt,
speedBps}`. `status` is `queued`, `running`, `done`, `failed` (the reason
in `error`) or `cancelled`. `revision` is the commit the file list was
taken at; every file resolves against it. `file` is the path in flight
and `speedBps` the rate over the last seconds, both only while running.
Errors are 400 (not a repository id), 403 (gated or private, no token),
404 (unknown repository or download), 409 (see above) or 502 (the Hub did not
answer). A download that needs more disk than the model directory has free,
plus 1 GB, fails at start with the numbers in `error`. A start answers 409
while a benchmark runs.

## Benchmarks

A benchmark replays a generated agentic session against the engine and keeps
what the engine measured. It measures the engine, not the model: the
session is scripted (a long system prompt with tool schemas, then turns
that each append a tool call and its result), no answer is checked, and
the figures come from the `timings` of the engine's own answers. Every
model gets the same prompts, so two quantizations of a model, two engine
builds or two configurations compare. A real client sends the model's own
output back, which the cache already holds, so its cache hit rate is a
little higher than the one reported here.

A run is one operation under the lock the actions and the engine manager
share: every other action answers 409 until it ends. It first loads the model and sizes every piece of the session with the
model's own tokenizer, so the prompts land on their token targets whatever
the tokenizer. Then, three times over: restart the engine, delete the SSD cache
tier, load the model as the default, one discarded request, and the turns.
The model stays loaded at the end.

| Route | Body | Answer |
|---|---|---|
| `GET /api/benchmarks` | | the runs, newest first |
| `POST /api/benchmarks` | `{model, preset}`: `short` (4 turns, to about 16k tokens) or `agent` (8 turns, to about 40k) | 202, the run. 403 unless the engine is on this host, managed by 1ctx-mlx-engine, up and idle, and no download is running; 409 while anything holds the lock |
| `GET /api/benchmarks/<id>` | | `{benchmark, turns}` |
| `POST /api/benchmarks/<id>/cancel` | | `{ok: true}`; the request in flight is aborted, which stops the generation in the engine. 409 when it is not running |
| `DELETE /api/benchmarks/<id>` | | `{ok: true}`. 409 for the run in progress |

A run is `{id, status, phase, error, model, quantization, preset, turns,
repetitions, maxTokens, schema, scriptHash, firstPromptTokens, appVersion,
engineVersion, engineArgs, chip, memoryBytes, os, summary, suspect,
peakMemoryBytes, peakActiveBytes, startedAt, finishedAt}`. `status` is
`running`, `done`, `failed` (the reason in `error`), `cancelled` or
`interrupted` (1ctx-mlx-engine went away mid-run); `phase` is where it is
or where it ended: `fit`, `prepare`, `warmup`, `turns`, `finish`. Two runs
compare when their `scriptHash` is the same. The peaks are the engine
process footprint and MLX's active memory, sampled once a second.

`summary` holds the figures, each `{median, spreadPct}` over the
repetitions and `null` where nothing was observed: `coldLatencyMs` and
`coldPrefillTps` (the first turn, nothing cached), `warmLatencyMs` and
`warmPrefillTps` (the later turns; a turn that prefilled under 256 tokens
is left out of the rate), `decodeTps` with `decodeFirstTps` and
`decodeLastTps` (the slope with depth; a turn that generated under 64
tokens is left out of these two), `cachePct` (cached over prompt
tokens, later turns), and `contextTokens`, the deepest prompt. Prefill
rates are over the tokens that were not cached. The latency is the
engine's tokenize plus prefill time; the engine reports no time to first
token per request, and queue time is not in it.

`suspect` lists why a finished run should not be trusted as it stands:
`cold turn hit the cache`, `cache did not hold` (a turn from the third on found under 90%
of the previous prompt cached; the second turn is the first with tool
messages, which the engine renders differently from the tool schemas on, a
cost that shows in `cachePct`), `little was generated` (under a quarter of what the turns
allowed, too little for a decode rate; a turn that stops at a tool call is
normal and no reason), `prompt size drifted`, `other requests ran`.

A turn is `{repetition, turn, promptN, cachedN, promptMs, predictedN,
predictedMs, tokenizeMs, finishReason}`, as the engine stated them.

## Engine management

Every route answers the page state, `{engine, self}`: the mode (`remote`,
`unmanaged`, `absent` or `managed`), the active and previous installs,
launchd's view of the job, the applied configuration and its defaults,
the release check, the release on offer, the operation in flight and the
last failure; and 1ctx-mlx-engine's own version, resources and release check.
Everything but the reads is refused with 403 when `--engine` is not on
this host, and with 409 while another operation or action holds the lock.

| Route | Body | Answer |
|---|---|---|
| `GET /api/engine` | | the page state |
| `POST /api/engine/check` | | asks GitHub for the releases of both programs now |
| `POST /api/engine/install` | `{tag, config}` | 202. The first install: downloads, verifies and unpacks the release, writes the LaunchAgent from `config` and starts it. 422 with `{error, issues: [{field, message}]}` when the configuration is refused; refused when something already answers on the port |
| `POST /api/engine/upgrade` | `{tag}` | 202. The same, then the swap to the new build with the applied configuration. A failed swap rolls back to the running build |
| `POST /api/engine/cancel` | | stops a download, a verify or an unpack and removes the partial files. 409 once the swap has begun |
| `PUT /api/engine/config` | the configuration | validates, rewrites the LaunchAgent and restarts mlx-serve; answers when it is verified. 422 as above; a configuration the engine does not come up on is rolled back |
| `PUT /api/engine/settings` | `{preReleases}` | whether pre-releases are offered |
| `POST /api/engine/service` | `{op}`: `start`, `stop` or `restart` | `stop` unloads the job until `start` or the next login |
| `POST /api/engine/rollback` | | back to the previous build; the build it leaves is removed |
| `POST /api/engine/dismiss` | | clears the last failure |
| `DELETE /api/engine` | | removes the LaunchAgent and the installed builds; models, caches and logs stay |
| `POST /api/self/restart` | | 1ctx-mlx-engine exits and launchd starts it again. Refused when it does not run under launchd |

A tag is accepted only when it is in the stored release list. Progress
arrives on the socket.

## WebSocket

`WS /ws` sends `{type: "snapshot"}` on connect (the same body as
`/api/snapshot`), then `{type: "sample"}` once a second, `{type: "event"}` when
an action finishes in any tab, `{type: "download"}` with the download as `data`
on every change of a download's state and twice a second while one runs,
`{type: "benchmark"}` with `{benchmark, repetition, turn, done}` (`done`
being the turns measured so far) on every step of a run and once more when
it has ended,
and `{type: "engine"}` with the engine page state as `data` on every change
of the manager's state and twice a second during an engine download.
