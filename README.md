<p align="center">
  <a href="docs/screens/mlx-spy-monitor.png">
    <img src="docs/screens/mlx-spy-banner.png" alt="mlx-spy monitor dashboard">
  </a>
</p>

# mlx-spy

[![test](https://github.com/stefanprodan/mlx-spy/actions/workflows/test.yml/badge.svg)](https://github.com/stefanprodan/mlx-spy/actions/workflows/test.yml)

Monitoring and control for LLM inference servers on Apple Silicon.

mlx-spy runs next to [mlx-serve](https://github.com/ddalcu/mlx-serve)
and shows what the engine is doing in real time: the request in flight,
the throughput, the caches and the memory, with a week of history behind
them. A single Bun binary, no dependencies.

## Features

**Monitor**

- Live throughput, time to first token and cache efficiency, with charts
  across 1h, 6h, 24h and 7d.
- The memory split: inference engine footprint, weights, the RAM prefix cache
  and the SSD tier against their budgets.
- The request in flight as a live bar: prefill, cached, decode.
- A models table to load, unload, set default and favorite; restart the
  engine and clear its SSD cache.
- A runtime panel: engine pid, RSS, CPU and GPU next to the host's chip,
  memory and disk.

**Requests**

- The last 50 requests with tokens, cached share, rates, time to first
  token and duration.

## Docs

- [Monitor and Requests](docs/monitor.md)
- [Engine](docs/engine.md)
- [API](docs/api.md)
- [Development](docs/development.md)

## License

Apache-2.0
