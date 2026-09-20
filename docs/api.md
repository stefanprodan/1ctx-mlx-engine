# API

mlx-spy serves its pages and a small JSON API from one port (11235 by
default). There is no authentication: the tailnet is the boundary, and the
browser-facing routes check that a request with an `Origin` header comes
from the dashboard's own host. Every JSON response carries
`cache-control: no-store`.

## Pages

| Path | Page |
|---|---|
| `GET /` | Monitor: tiles, charts, models, runtime |
| `GET /requests` | The request in flight and the last 50 finished ones |

## Monitoring

| Route | Answer |
|---|---|
| `GET /api/snapshot` | the latest sample, the model list, the engine's capabilities and cache budgets, host facts, the action log, the downloads and the model directory |
| `GET /api/history?range=1h\|6h\|24h\|7d` | columnar series for the charts and the tiles' range totals: rates, cache ratios, TTFT and the token and request counters; 1h is raw seconds, longer ranges are bucket averages |
| `GET /api/requests` | the last 50 finished or cancelled requests, newest first |

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
| `historyClear` | none | wipe mlx-spy's own sample history |
| `requestsClear` | none | wipe the stored requests and the last request in the bar; samples are kept |
| `favorite` | `{"model": "<id>"}` | toggle the daily-driver star |

Errors are `{"error": "<sentence>"}` with 400 (bad input), 403
(cross-origin), 404 (unknown model or action), 409 (another action runs) or
501 (the engine lacks the capability or is remote).

## Downloads

mlx-spy downloads a model from the Hugging Face Hub itself, into
`--model-dir` (`~/.mlx-spy/models` by default) as `<owner>/<name>/`, one
pull at a time from a queue kept in its database. Every file streams into
`<file>.mlx-spy-part` and resumes with a Range request after a cut, a retry, a
cancel or a restart of mlx-spy; LFS files are checked against the Hub's
sha256 before the rename. The engine takes no part in the download; when
a pull completes mlx-spy asks it to rescan its model directory, so the
model appears in the list when that directory is the one the engine
serves. A gated repository needs `hf.key` in the secrets directory.

| Route | Body | Answer |
|---|---|---|
| `GET /api/pulls` | | the last 20 pulls, newest first |
| `POST /api/pulls` | `{repo}`: `owner/name` or a huggingface.co URL | 202, the queued pull; the same repository again resumes its failed or cancelled pull, and answers 409 while one is queued or running |
| `GET /api/pulls/<id>` | | the pull |
| `POST /api/pulls/<id>/cancel` | | the pull, paused: its parts stay on disk and a new POST for the repository resumes it. 409 when it is not queued or running |
| `DELETE /api/pulls/<id>` | | `{ok: true}`; a running pull is stopped first, then its files, partial or finished, and its record are deleted |

A pull is `{id, repo, revision, dir, status, bytesTotal, bytesDone,
filesTotal, filesDone, file, error, createdAt, updatedAt, finishedAt,
speedBps}`. `status` is `queued`, `running`, `done`, `failed` (the reason
in `error`) or `cancelled`. `revision` is the commit the file list was
taken at; every file resolves against it. `file` is the path in flight
and `speedBps` the rate over the last seconds, both only while running.
Errors are 400 (not a repository id), 403 (gated or private, no token),
404 (unknown repository or pull), 409 (see above) or 502 (the Hub did not
answer). A pull that needs more disk than the model directory has free,
plus 1 GB, fails at start with the numbers in `error`.

## WebSocket

`WS /ws` sends `{type: "snapshot"}` on connect (the same body as
`/api/snapshot`), then `{type: "sample"}` once a second, `{type: "event"}` when
an action finishes in any tab, `{type: "pull"}` with the pull as `data`
on every change of a download's state and twice a second while one runs.
