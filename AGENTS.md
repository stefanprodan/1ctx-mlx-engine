# AGENTS.md

How to work on **1ctx-mlx-engine**, a monitor and control panel for LLM
inference servers on Apple Silicon (mlx-serve first). One Bun/TypeScript
program samples the engine and the host once a second, keeps history, and
serves a dashboard with the control actions the engine's own console lacks.

- **Runtime:** Bun only, TypeScript run directly. No Node.
- **Platform:** macOS on Apple Silicon. Host probes use `bun:ffi`.
- **Zero runtime dependencies.** The devDependencies bundled into the
  binary at build time are uPlot, Preact and `@preact/signals` (the
  page); `preact-render-to-string` is for the tests only. All exact
  pins. A new package needs the user's explicit go-ahead in the
  conversation, official npm only, and the 24 h cooldown below.
- The roadmap is in `plans/`.

## The dev loop

Everything goes through the Makefile; each target runs the `package.json`
script of the same name.

```sh
make preview        # (re)start the local preview, detached, hot reload
make preview-stop   # stop it
make preview-log    # tail its log
make preview-clean  # stop it and wipe its db, log and pid (make clean does too)
make lint           # biome check --write, then tsc
make test           # bun test; both run after any code change, before finishing
make build          # standalone binary in bin/
make deploy-studio  # build, install and restart on the Mac Studio
```

### Seeing a change

1. `scripts/preview.sh status`. If it is not up, `make preview`. It runs the
   source on `http://127.0.0.1:11236` against this machine's engine
   (`127.0.0.1:11234`) and the real model directory,
   `~/models`, with its pid, db and log under `.preview/`.
   Never start the server by hand in the background. Development needs no
   other host: when nothing is installed, the Engine page installs mlx-serve
   here (a real LaunchAgent, a real build under
   `~/.1ctx-mlx-engine/engine`), and `mlx-community/Qwen3.5-0.8B-4bit` (625
   MB) is enough to serve requests. `PREVIEW_ENGINE=studio make preview`
   watches the Studio named in `scripts/studio.env` (git-ignored) instead,
   for real load and big models; everything that manages is disabled there.
2. Edit. The preview runs with `ONECTX_MLX_DEV=1`, which turns on Bun's dev
   server: an edit to a stylesheet under `src/client/` hot-reloads in the
   open tab, an edit to a `.ts` or `.tsx` file under `src/client/` reloads
   the page (Bun has no fast refresh for Preact; the state comes back from
   the server); server-side TypeScript restarts the process through `bun
   --watch`. The one exception: an edit to `index.html` can leave the dev
   server with "Failed to load bundled module" in the page; `make preview`
   clears it.
3. Look at it. Open `http://127.0.0.1:11236/` and `/requests` in
   Chrome through the DevTools MCP: screenshot at a desktop width (1400)
   and a phone width (390), read the console (it must stay empty), and
   measure with `evaluate_script` when a pixel matters. A change to a
   shared element (the rail, a card, a table) is checked on every page
   it appears on.
4. `make lint` and `make test`.
5. Report what you verified and how. Do not commit unless asked; the user
   batches changes.

### The Studio

The Studio is the user's Mac Studio on the tailnet: it runs mlx-serve and
its own 1ctx-mlx-engine as launchd agents. Read `docs/internal/studio.md` before
any ssh command; it has the paths, the safe commands and the rules (never
`GET /props`, never start processes by hand over ssh, never touch the
user's other services). `make deploy-studio` is the only deploy path.
Deploy when asked, then say what is now running there.

### Testing without a browser

- `bun src/main.ts --once` prints one sample from the local engine: exit
  0 when the engine answered, 2 when it did not, 1 on bad arguments.
  With `--engine http://<studio>:11234` the engine is remote, so
  `enginePid` is null, `procRss` 0 and `disk` empty by design.
- Parsers and rate math are pure and tested on recorded fixtures in
  `test/fixtures/`. Record new ones with `curl <engine>/metrics.json` and
  `curl <engine>/v1/models`, pretty-printed. A `/props` body is recorded
  the same way, but only while a model is resident (rule 1).
- `handle()` in `src/server/web/index.ts` is separate from `serve()`, so
  tests call it with a `Request`.
- A fake HTTP server in a test comes from `testServer()` in
  `test/server/serve.ts`, never a bare `Bun.serve`: it binds `127.0.0.1`,
  where the tests connect. A default bind is the IPv6 wildcard, which
  macOS lets share a port with another program's loopback socket, and the
  test then talks to that program.

## Rules that protect the engine

1. **`GET /props` only while a model is resident.** It goes through the
   model-load path, so on an idle engine it cold-loads the default model:
   it undoes API unloads, evicts the model a client just loaded and halves
   decode speed during a request. `Sampler.readProps()` is the only caller,
   once per engine process, and only when the model list it already polls
   shows something loaded. It is there for the two facts no other endpoint
   reports, the build and the prefix cache budgets, and it is the only way
   a remote engine can state either. The answer is stored in the `props`
   meta row and read back at start, so an engine that comes back empty
   still shows its last known build: stale by design. Every other call
   stays on the endpoints answered before the load step: `/health`,
   `/metrics.json`, `/v1/models` and, once after a download,
   `/v1/models/rescan`. Anything new is verified the same way in
   mlx-serve's `src/server.zig` first.
2. **The sampler is read-only, and no engine endpoint is called outside
   the four it already uses.** `load`, `unload`, `restart` and
   `diskClear` run only from an explicit user action through the actions
   layer, are logged, and are disabled when the engine URL is not local.
   The benchmark (`src/server/benchmark/`) is the one other caller of the
   engine: `POST /v1/chat/completions`, and `POST /tokenize` to size its
   prompts (on the default model, which it has just loaded, so nothing
   cold-loads), only from the button on the Benchmark page, for the length of a run, under the lock the actions
   hold, local and managed only, logged. It is the only call here that
   makes the engine work, and nothing else may use it.
   There are two other network callers, and the engine takes no part in
   either: the downloader (`src/server/models/`) fetches from
   `huggingface.co` into `--model-dir` when a user asks for a repo, then
   asks the engine to rescan; the engine manager
   (`src/server/engine/manager/`) reads the GitHub releases of mlx-serve and
   1ctx-mlx-engine every 6 h and downloads a release asset only from a button.
3. **No spawns on the monitor path.** Host numbers come from FFI, directory
   sizes from recursive stat. The program's spawn paths call `launchctl`
   with argument vectors and never a shell: the local-only "free" action
   and explicit service commands. Disk clear and model delete are
   filesystem deletes, both local-only. The cache path comes from the
   adapter's allow-list, never from the request. A delete's path is built
   from `--model-dir` and an id the engine lists, checked against the root,
   and refused when the owner or model dir is a symlink.
4. **Fail fast on the engine.** Sampler requests time out in 3 s and a
   failed read produces a sample with `engineUp: false`; a hung engine
   never stalls the loop.

5. **The manager is local-only and runs from a button or a command.**
   Every management route needs `isLocalUrl(--engine)`. It shares one
   lock with the actions, so nothing loads a model into an engine that
   is being replaced. It never spawns a package manager. A LaunchAgent
   is staged and parsed before the job is touched, and the engine's swap
   writes a journal row first, which `reconcile()` finishes or rolls back
   at the next start. `launchctl print` runs after an operation, never
   from `snapshot()`. 1ctx-mlx-engine manages only an engine it installed (the
   `managed` marker). When the marker is gone (a wiped database), the
   start adopts the engine back, and only when it is provably ours: the
   plist under our own label, its program inside our versions directory,
   the binary there, and its `--version` naming that directory's tag; the
   config is read back from the plist's arguments. It never adopts or
   imports another agent's plist.

## Layout

```
src/main.ts          thin entry: CLI result dispatch and plain error handling

src/shared/          what crosses the wire, types and pure guards only; the
                     server and the page both import it, it imports neither
  engine.ts          the contract between the manager and the Engine page:
                     EngineConfig, EngineState, SelfState, the route bodies
  sample.ts          Sample, as /api/snapshot and the socket carry it
  models.ts          the model row, the capabilities, the cache budgets
  host.ts            the host facts and the disk figures
  requests.ts        the request in flight and the last finished one
  history.ts         the ranges and the columnar series of /api/history
  actions.ts         the action names, isActionName, the action log row
  downloads.ts       a model download as the routes and the socket say it
  benchmark.ts       a benchmark run, its turns, figures and progress
  socket.ts          Snapshot and the WsMessage union
  paths.ts           expandHome, abbreviateHome

src/server/
  app.ts             foreground application wiring, macOS floor and log sink
  cli.ts             pure CLI parsing for foreground and service commands;
                     VERSION from package.json in development and injected
                     at build time
  actions.ts         load, unload, default, free, diskClear, delete (the
                     last three local-only), historyClear, requestsClear,
                     favorite; one at a time, logged, last 50
  lib/log.ts         levelled callable logger, repeat collapsing, appending
                     file sink and stopped launchd-log rotation
  lib/lock.ts        the one lock the actions and the manager share
  lib/secrets.ts     the key files in ~/.1ctx-mlx-engine/secrets
                     (.preview/secrets from source); loadKey and secretsDir, read once at
                     start for the Hub token and the optional GitHub one
  lib/fetch.ts       what the two downloaders share: redirects followed by
                     hand so a token never crosses origins, the stall
                     timeout, the free-space margin
  lib/net.ts         the default port and the tailnet address
  host/              probes: darwin.ts (bun:ffi, offsets verified with
                     offsetof(), load-bearing comments), info.ts (static host
                     facts), disk.ts (cache dir sizes, no spawn), local.ts
                     (is the engine on this host), types.ts (the probe
                     interface), index.ts (facade)
  monitor/sample.ts  computeRates and buildSample (pure, tested); takeSample
                     does the I/O for --once
  monitor/requests.ts
                     trackRequests: the request in flight and the last
                     finished one, from the counter deltas (pure, tested)
  monitor/sampler.ts the 1 Hz loop; carries epoch, counters and the last
                     request across restarts through the history meta table
  monitor/history.ts ring buffer (1 h) plus bun:sqlite
                     (~/.1ctx-mlx-engine/engine.db):
                     samples (7 day retention, bucketed series() for uPlot;
                     only the columns the page reads back, the memory and
                     host gauges are live-only), models (ids and the
                     favorite flag), requests (the last 50), meta (the
                     sampler's carry-over and the engine's last /props)
  benchmark/script.ts
                     pure: the generated agentic session a run replays,
                     seeded, the same for every model but for its tag
  benchmark/hash.ts  pure: the name of a workload, what two runs share to
                     compare
  benchmark/stats.ts pure: the figures and the suspect rules over the
                     engine's timings
  benchmark/output.ts
                     pure: whether a turn's answer looks like a model that
                     does not work (empty, undecodable, noise, a loop), and
                     whether it is in another script than English's
  benchmark/store.ts benchmarks and benchmark_turns over the same sqlite file
  benchmark/runner.ts
                     one run as one locked operation: the tokenizer fit, then per
                     repetition restart, clear, load, warmup, turns; cancel,
                     progress on /ws
  models/hub.ts      the Hugging Face Hub: parseRepoId, parseRepoFiles (pure,
                     tested on a recorded body), the resolve URL, fetchRepo
  models/store.ts    DownloadStore: downloads and download_files over the
                     same sqlite file; the rows are the resume state
  models/download.ts Downloader: the queue (one at a time), cancel, remove,
                     resume at start; progress on /ws; tested against a fake
                     Hub in test/server/models/download.test.ts
  models/transfer.ts one file of a download: Range resume into
                     <file>.1ctx-part, sha256 while writing, retries
  models/error.ts    DownloadError, the status a route answers with
  models/remove.ts   pure path work and the delete of a model's checkpoint:
                     the id is checked against --model-dir, never followed
  models/spec.ts     pure: config.json, the generation config, the card's
                     license, the parameter count from safetensors
                     headers, the join with the engine's meta
  models/read.ts     SpecReader: a checkpoint's files read under the
                     delete's path rules, headers only, cached by mtime
  service/plist.ts   pure LaunchAgent XML rendering
  service/launchd.ts injected launchctl verbs, status parse, atomic write and
                     the ordered staged reload sequence
  service/service.ts install, status, lifecycle and uninstall for its own
                     LaunchAgent
  engine/types.ts    the Engine interface and the normalised metric types
  engine/mlxserve.ts mlx-serve adapter: parseMetrics/parseModels/parseProps
                     and parseModelMeta (kept from the same /v1/models read)
                     (pure, tested), the HTTP client, load/unload, cache dir
                     and log paths, props() under rule 1; the service
                     label is the managed one only once 1ctx-mlx-engine owns it
  engine/config.ts   pure: DEFAULTS, configToArgs, validateConfig over the
                     effective argv, the size grammar, and the launchd
                     argument parse that reads an unmanaged engine's budgets
  engine/release.ts  pure: the GitHub releases body, the asset pick, tag
                     order and trust, offered() (never a downgrade), the
                     `--version` output; fetchReleases is the one I/O call
  engine/store.ts    EngineStore over the History db handle: the applied
                     and pending config, the settings, the managed marker,
                     the install records, the journal, the release checks
  engine/manager/    EngineManager under rule 5, one class over plain
                     functions that share a context: index.ts (the verbs,
                     the lock, state), stage.ts (download, hash, unpack),
                     swap.ts (the port preflight, the staged reload, the
                     four-fact verification, the log tail), journal.ts
                     (reconcile, restore, prune), adopt.ts (our own
                     LaunchAgent back after a wiped database), poll.ts
                     (the release poll), self.ts (1ctx-mlx-engine's own
                     section), context.ts
  web/index.ts       Bun.serve: the page, /api/snapshot, /api/history,
                     /api/requests, POST /api/actions/<name>, /ws;
                     development mode from ONECTX_MLX_DEV=1; handle() separate
                     from serve() for tests
  web/engine.ts      the /api/engine routes and /api/self/restart
  web/downloads.ts   /api/downloads and its sub-routes
  web/models.ts      GET /api/models: the list with each model's spec
  web/benchmarks.ts  /api/benchmarks and its sub-routes
  web/http.ts        the JSON answer, HttpError, the bounded body read,
                     sameOrigin
  web/deps.ts        WebDeps: what the routes are handed

src/client/
  index.html         the shell: head, the rail, page head, page and dialog
                     roots, the script tag; Bun bundles the CSS and
                     main.tsx from it
  main.tsx           entry: renders the shell and the view that follows
                     the page signal (the Overview's footer with it),
                     starts the Overview's tracking, opens the store,
                     reads the runs and requests once
  store.ts           PAGES (the rail's rows and the crumbs), the page
                     signal and go(): the rail swaps pages in place, a
                     modified click stays a browser link; the WebSocket
                     client and its signals (connection,
                     snapshot, sample, models, event, busy, downloads,
                     benchmark, engineMode); listen() for the code that renders by
                     hand; landsOnEngine, the bare-host landing rule
  api.ts             api<T>(): one JSON call to this server
  format.ts          gb, size, num, count, diskSize, duration, orderModels
                     (pure, tested)
  icons.tsx          the inline SVGs as components, 1ctx's logo and the
                     rail's icons
  fonts/             1ctx's IBM Plex Sans and JetBrains Mono, Regular only
  style/tokens.css   the custom properties, the only :root that has any,
                     and the two @font-face rules
  style/base.css     what more than one page uses: cards, section heads,
                     pills, buttons, tables, the request bar, facts
  shell/             Rail.tsx (1ctx's rail, its folded strip, the drawer
                     below 720 and the user menu), Head.tsx (the sticky
                     crumb), shell.ts (narrow, folded and drawer signals),
                     Footer.tsx, Pill.tsx, Confirm.tsx (the dialog with a
                     promise API), Select.tsx (the one select, a button and
                     a listbox, never a native one), Grid.tsx (the one
                     design of a list of figures, the Requests history and
                     the benchmark runs: the card, its search and filters,
                     the rows, the opened row's groups, grid.css), shell.css,
                     rail.css
  monitor/           Monitor.tsx (the page: range, series and tile memory
                     signals), Tiles.tsx, Charts.tsx (uPlot in a ref),
                     Models.tsx, Runtime.tsx, RangePicker.tsx, RequestBar.tsx,
                     Event.tsx, Download.tsx (the download rows in the
                     models table), monitor.css; the pure, tested
                     tiles.ts (seed/apply and the eight tiles), range.ts,
                     series.ts, request.ts, download.ts (the row copy);
                     actions.ts (runAction, confirmText, engine facts)
  requests/          Requests.tsx (the page, on the grid), requests.css;
                     the pure, tested list.ts (the search, the figures, the
                     opened row's groups)
  benchmark/         Benchmark.tsx (the two pages, Run and Scorecard, and
                     the runs' fetch they share), Run.tsx (the card: what to
                     run, or how far it is), Scorecard.tsx (a model per
                     row at a preset, scorecard.css), Scatter.tsx (the
                     wait and decode plane under it, SVG), Runs.tsx (the
                     search, the table, the deltas, the opened row),
                     Turns.tsx, benchmark.css; state.ts
                     (the signals and the calls); the pure, tested
                     report.ts (the cells, the deltas, the text report),
                     scorecard.ts (the rows, the bars, the best) and
                     scatter.ts (the dots, the colour slots, the ticks)
  models/            Models.tsx (the page: the Hub download form and the
                     downloads, the models on the grid, a row opening to
                     its spec and the actions), models.css; state.ts (the
                     specs and their fetch), downloads.ts (the download
                     calls, the Overview's rows share them); the pure,
                     tested spec.ts (the join, order, filters, groups)
  engine/            Engine.tsx (the Server page), Self.tsx, Service.tsx (the
                     mlx-serve head), Build.tsx (facts and the one row that
                     is a release, an operation or a failure), Progress.tsx,
                     Config.tsx (the form and its foot), Fields.tsx (its
                     rows), engine.css; state.ts (the signals and the
                     calls); the pure, tested config.ts (form to config,
                     changed fields) and release.ts (the row and pill copy)

test/                bun test suites: server/, client/ (pure modules and
                     render-to-string checks) and shared/ mirror src/;
                     fixtures/ holds recorded engine bodies; structure.ts
                     and structure.test.ts are the layout rules
docs/                user docs: monitor, models, engine, benchmark, api
                     (keep in step with src/server/web/), development;
                     internal/studio.md is the Studio guide
scripts/             preview.sh, install.sh (the one install path: download,
                     verify, place the binary, `service install --restart`),
                     deploy-studio.sh (build, copy, then the same command)
                     and studio.env.example
plans/               the development plan and milestones
```

The styles follow the engine's own console (its tokens: #131314 page,
#1e1f20 cards, #0f1216 inset tiles, 10px uppercase labels, bold mono
values).

### Rules the structure test enforces

`test/structure.ts` is the source of truth; `make test` fails on a
violation, and every rule has a rejected fixture under
`test/fixtures/structure/`.

- `shared/` imports only `shared/`. `client/` imports `client/` and
  `shared/`, never `server/`. `server/` imports `client/` only in
  `app.ts`, for the page.
- `web/` is the outermost server area: only `app.ts` imports it. Only
  `main.ts` imports `app.ts`, and nothing imports `main.ts`.
- No import cycles between files, type-only imports included.
- A file under `src/` over 500 lines fails unless it is listed in
  `LINE_EXEMPTIONS` with a reason. The list is empty.
- Every relative import carries its extension, and every import is a
  string literal: no computed `import()` and no `require`.
- Every stylesheet opens with `@layer tokens, base, pages;` and puts its
  rules in one of the three. Only `style/tokens.css` declares custom
  properties on `:root`. A rule outside every layer fails unless the
  file is in `UNLAYERED` with a reason. `monitor.css` is the one entry:
  uPlot's own sheet is unlayered, an unlayered rule beats every layered
  one, so the overrides of it have to be unlayered too.

Data flow: adapter (`/metrics.json`, `/v1/models`) → `Reading` →
`computeRates` over the previous reading, joined with the host probes →
`buildSample` → History (ring + SQLite) and listeners → `/api/snapshot`,
`/api/history` and the `/ws` push → the page. Actions go the other way: a
button → confirm dialog → `POST /api/actions/<name>` → `Actions.run` → an
event on `/ws` that every tab shows. A download: the Models page's form →
`POST /api/downloads` → `Downloader` → `{type: "download"}` on `/ws` →
the rows on the Models page and in the Overview's models table of every
tab.

## mlx-serve specifics worth knowing

- Model ids are `<org>/<name>` in serve mode.
- `generation_tokens_live` and `prefill_tokens_live` hold the token count of
  the current request and drop back when a new one starts, so a negative
  delta means "new request", not a reset. Counters (`*_total`) only go
  backwards on a process restart; that bumps the epoch.
- `memory_mb` is the process footprint (matches libproc's phys footprint);
  `mlx_active_bytes` is weights plus KV; `mlx_cache_bytes` is MLX's
  reclaimable pool, not the prefix cache. The hot prefix cache has no
  gauge, so it is estimated as active minus the loaded models'
  `bytes_resident` and labelled as such.
- The engine's version is in one endpoint only, `/props`
  (`settings.version`), which is under rule 1. It also prints it in the
  banner it writes to its log at every start ("mlx-serve 26.9.5 (MLX
  0.32.2)", the only place the MLX version appears), but 1ctx-mlx-engine
  does not read that log.
- The engine does not say which model is the default, nor which model served
  a request; 1ctx-mlx-engine attributes a request to the resident favorite,
  else the first resident by id.
- Disk tier at `~/.mlx-serve/kv-cache/<fingerprint>/`; server log at
  `~/.mlx-serve/logs/mlx-serve-<port>.log`. The service label is
  `com.ddalcu.mlx-serve`; "free" is a `launchctl kickstart -k` because a
  fresh process has no default model and so nothing to cold-load.
- `--prefix-cache-mem` and `--prefix-cache-disk` are per resident model
  (verified 2026-09-07 in `scheduler.zig` at 0897f01). The adapter reads
  them from the plist's ProgramArguments, and `/props` reports what the
  running process actually uses (`settings.prefix_cache`, the two agreed on
  2026-09-20); the tiles multiply the budget by the resident model count
  (hot) and the tier dir count (SSD).
- The hot cache evicts per workload since 26.9.2, keyed by
  `prompt_cache_key`, so one client's batch evicts its own entries first.
- Host memory on macOS: `free` is small by design; free + inactive is the
  practical headroom. `compressed` is the compressor's page count.

## Conventions

- **This is alpha software until the user says otherwise. Backwards
  compatibility is not required.** No deprecated fields, no legacy
  projections, no "old client" paths, no compatibility shims in tests.
  Change the socket and API contracts, the fixture format and the
  database schema freely; wiping the database on an upgrade is
  acceptable. The page and the tests live in this repo and move with the
  server in the same change.
- **Style is enforced by Biome** (`biome.json`): 2-space indent, double
  quotes, semicolons, trailing commas, 80 columns. Biome also rejects a
  selector of lower specificity after a higher one that matches the same
  element; order CSS rules accordingly.
- **Types** are checked by `bun tsc --noEmit` as part of `make lint`. The
  browser client shares the tsconfig (lib includes DOM).
- **Comments explain why, not what.** The engine caveats above are
  load-bearing where they appear in code; keep them.
- **Development builds report `v0.0.0-dev`.** `package.json` stays at
  `0.0.0-dev`; tagged releases inject `v<semver>` through
  `make build VERSION=...` and verify the compiled binary. Do not edit the
  package version for a release.
- **Pure logic separate from I/O.** Parsers and rate math take plain data
  and are tested on fixtures; fetches and sleeps live in thin wrappers.
- **UI copy is short and plain.** Labels are one or two words ("idle",
  "No requests yet."); no filler sentences to fill space, keep the height
  with CSS instead. Empty states keep the layout of the filled state so
  nothing jumps when data arrives.
- **Docs move with the code.** A change to a page updates
  `docs/monitor.md`; a route change updates `docs/api.md`; a change to the
  Studio setup updates `docs/internal/studio.md`, after it was run there.
- **Commit messages are short.** Subject under 72 characters, `Area:
  what changed`. Body optional, at most three short lines saying why,
  never a list of everything in the diff; GitHub truncates the rest.
- No em-dashes in prose or docs. `perl -i -pe` for global replaces, not
  sed. `uv` for ad hoc Python, never pip. No `Co-authored-by` or session
  trailers in commits or PRs. npm packages official only, exact pins,
  `bun install --ignore-scripts`, 24 h cooldown on new releases.
