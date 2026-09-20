# Development

Bun 1.4 or newer and macOS 26 or newer on Apple Silicon. The binary
checks the macOS major at normal startup and during `service install`.
`--once` remains available for parser and engine probes without that startup
check.

```sh
bun install --ignore-scripts
make dev ARGS="--engine http://127.0.0.1:11234"   # live reload
make lint                                         # Biome + tsc
make test                                         # bun test
make build                                        # v0.0.0-dev binary in bin/
make build VERSION=v1.2.3                         # inject a release version
make install-bin                                  # build and install to ~/.local/bin
```

`package.json` stays at `0.0.0-dev`. A normal source or binary build reports
`v0.0.0-dev`; `make build VERSION=v1.2.3` uses Bun's build-time definition
to embed `v1.2.3` without editing the package file.

A pushed semantic-version tag such as `v1.2.3` runs the release workflow.
It validates the tag, runs lint and tests, builds a native Darwin ARM64
binary with the tag injected, verifies `mlx-spy --version`, then publishes
an archive, SHA-256 checksum and build-provenance attestation. A version
with a hyphen, such as `v1.2.3-rc.1`, becomes a prerelease.

Useful flags while developing: `--listen 127.0.0.1:11299` to keep a second
instance off the default port, `--db :memory:` to keep nothing, `--log-file
<path>` to use the appending 8 MB rotating file sink (`off` keeps stderr),
and `--once` to print one JSON sample and exit (exit code 2 when the engine
did not answer). The service command generates and controls mlx-spy's user
LaunchAgent:

```sh
mlx-spy service install [flags] [--restart]
mlx-spy service status
mlx-spy service start|stop|restart
mlx-spy service uninstall [--purge]
```

The generated agent writes normal logs to `~/.mlx-spy/mlx-spy.log` and uses
`~/.mlx-spy/launchd.log` as its stdout and stderr crash catcher. Both rotate
to one `.1` file at 8 MB; the latter rotates while the job is stopped during
a reload.

The page is bundled by Bun from `src/ui/index.html`: once at startup in
the compiled binary, on demand when `MLX_SPY_DEV=1` is set, which
`make dev` and `make preview` do; then a CSS edit hot-reloads and an edit
to the client's TypeScript reloads the page. The client is Preact with
signals (`src/ui/main.tsx`, `store.ts`, `shell/`, `monitor/`,
`requests/`), bundled like uPlot so the binary still has no runtime
dependencies. Logic lives in plain `.ts` modules that take data and
return data (the tiles, the chart series, the request bar) and is tested
on recorded fixtures; components hold only what the DOM owns (uPlot,
dialogs, timers). A new component gets a render-to-string check in
`test/ui/` asserting the class names `style.css` depends on.
`make preview` (re)starts a detached instance on `127.0.0.1:11236`
against this machine's engine on `127.0.0.1:11234` (`make preview-stop`,
`make preview-log`, `make preview-clean` to also wipe its db and log).
When no engine is installed, the Engine page installs one, and a small
checkpoint such as `mlx-community/Qwen3-0.6B-4bit` is enough to serve
requests. `PREVIEW_ENGINE=studio make preview` watches the engine named
in `scripts/studio.env` instead; any other value is taken as its URL.

The model downloader reads a Hugging Face token from
`~/.mlx-spy/secrets/hf.key` when installed and from `.preview/secrets/hf.key`
when run from source. It buys gated repositories and the Hub's higher rate
limits. The file holds the bare token; the start log says `hf key: <path>` or
`hf key: none`. It is read once at start, so a change needs a restart.

Downloads land in `--model-dir`, `~/.mlx-spy/models` by default, for the
preview too (`.preview/models/` when it watches a remote engine); point
it at the engine's own model
directory for a downloaded model to be served. The downloader is tested
against a fake Hub in `test/server/models/download.test.ts`; a real download of a small
repository such as `Jundot/gemma-4-E2B-it-oQ4e-mtp` (3.9 GB) is the
end-to-end check.

## Layout

`AGENTS.md` at the repository root describes every module, the data flow,
the rules that protect the engine and the conventions (Biome style,
comments that explain why, pure logic tested on recorded fixtures). Read it
before changing anything; it is written for humans too.

## Tests

`bun test` runs the suites under `test/`. Parsers and rate math are tested
on fixtures recorded from a live engine (`test/fixtures/`): `/metrics.json`,
`/v1/models` and `/props` bodies. Record new ones with `curl`, and a
`/props` body only while a model is resident (AGENTS.md rule 1).
