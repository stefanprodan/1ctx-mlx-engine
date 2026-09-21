<p align="center">
  <a href="docs/screens/monitor.png">
    <img src="docs/screens/banner.png" alt="1ctx-mlx-engine monitor dashboard">
  </a>
</p>

# 1ctx-mlx-engine

[![test](https://github.com/stefanprodan/1ctx-mlx-engine/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/1ctx-mlx-engine/actions/workflows/test.yml)

1ctx-mlx-engine is a web dashboard for running local LLMs with MLX on an
Apple Silicon Mac. It installs and upgrades
[mlx-serve](https://github.com/ddalcu/mlx-serve), downloads models from
Hugging Face, and shows you what the engine is doing.

You see the current request, token speed, memory use, how much of each
prompt the engine could reuse, and recent history in one place, from any
browser on your network. It is a single binary with no runtime
dependencies.

## What you get

- **Overview:** Watch requests as they run. See prompt and generation
  speed, memory use, how much of each prompt the engine could reuse, and
  charts for the last hour through the last seven days.
- **Requests:** Look through the last 50 requests, including tokens,
  speed, time to the first token, duration, and cancelled requests.
- **Models:** Download models from Hugging Face, follow their progress,
  and pause or resume downloads. See each model's size, context window,
  and details, then load, unload, favorite, or delete it.
- **Server:** Install, update, roll back, configure, start, and stop
  mlx-serve from the browser.
- **Run:** Measure a model with the same scripted agent session each
  time. See the time to the first answer, prompt speed, generation speed,
  prompt reuse, and peak memory.
- **Scorecard:** Rank models by their latest run and compare how they
  perform on this Mac at 20K, 40K, or 60K context.

## Install

On macOS 26 or later, on Apple Silicon:

```sh
curl -fsSL https://raw.githubusercontent.com/stefanprodan/1ctx-mlx-engine/main/scripts/install.sh | bash
```

The script downloads the latest release, verifies its checksum, puts the
binary in `~/.1ctx-mlx-engine/bin` and starts it as a LaunchAgent, then
prints the URL of the page. Running it again is the upgrade. It never
uses `sudo` and touches no shell file. Models are downloaded to `~/models`
unless `--model-dir` says otherwise.

Arguments go to `service install`, and `VERSION` picks a release:

```sh
curl -fsSL https://raw.githubusercontent.com/stefanprodan/1ctx-mlx-engine/main/scripts/install.sh | bash -s -- --listen 0.0.0.0:11235
curl -fsSL https://raw.githubusercontent.com/stefanprodan/1ctx-mlx-engine/main/scripts/install.sh | VERSION=v0.2.0-rc.1 bash
```

Use the script, not a browser download: the binary is not notarized yet,
and macOS refuses an archive a browser has quarantined.

For the command on your `PATH`:
`ln -s ~/.1ctx-mlx-engine/bin/1ctx-mlx-engine /usr/local/bin/`.

To uninstall, run
`~/.1ctx-mlx-engine/bin/1ctx-mlx-engine service uninstall --purge`, then
remove `~/.1ctx-mlx-engine`. The models are not in it and stay.

## Docs

- [Monitor and Requests](docs/monitor.md): live activity, history, and
  request details.
- [Models](docs/models.md): downloads, model details, and model controls.
- [Server](docs/engine.md): install, update, configure, and troubleshoot
  mlx-serve.
- [Benchmark](docs/benchmark.md): run tests, read results, and compare
  models.
- [API](docs/api.md): HTTP and WebSocket endpoints.
- [Development](docs/development.md): build, test, and work on the
  project.

## License

Apache-2.0
