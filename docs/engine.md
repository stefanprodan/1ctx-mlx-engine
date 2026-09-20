# Engine

The Engine page installs, configures, runs and upgrades one mlx-serve on
the machine 1ctx-mlx-engine runs on. It needs `--engine` to point at this host;
for a remote engine the page is read-only and says so.

## The three sections

**1ctx-mlx-engine** shows the running version (marked `dev build` when it
runs from source), its memory and CPU, and, when a release is out, the
install command to copy: running it again is the upgrade, and it restarts
the service into the new build. Restart exits the process and launchd
starts it again.

**mlx-serve** shows the installed build with its MLX version, the
previous build with Rollback, the listener and the process's memory and
CPU. The pill in the head is the service state:

| Pill | Meaning |
|---|---|
| `not installed` | nothing answers on the port; Install is on the Configuration foot |
| `unmanaged` | an mlx-serve that 1ctx-mlx-engine did not install answers on the port. It is shown, never touched; stop it before installing |
| `up 3d 04h` | the managed job is serving |
| `stopped` | the job is unloaded until Start or the next login |
| `crashed, exit 1` | launchd keeps restarting it; the launchd log says why |
| `restarting` | a swap is in progress |
| `remote` | the engine is on another host |

The row under the facts is one of three things: a release (`Latest
release`, `Update available`, or `Up to date` with Check now), an
operation with its phase and a bar, or the last failure with the reason
and the tail of the engine's launchd log. `include pre-releases` decides
what the row offers; a release older than the running build is never
offered.

**Configuration** is the engine's launch flags. A blank field leaves the
engine's own default, and the placeholder names it. Changed fields are
outlined; Apply rewrites the LaunchAgent and restarts mlx-serve. A refused
field says why beneath itself. Before anything is installed the foot holds
Install, which uses what the form holds.

## What an install does

Releases come from `github.com/ddalcu/mlx-serve`, checked every 6 hours
and on Check now. Only `mlx-serve-bin-macos-arm64.tar.gz` is used.

1. The asset is downloaded into `~/.1ctx-mlx-engine/engine/downloads/` and its
   sha256 is checked against the digest GitHub publishes for it.
2. It is unpacked into `~/.1ctx-mlx-engine/engine/versions/<tag>/` and
   `mlx-serve --version` must report the release's version.
3. `~/Library/LaunchAgents/com.stefanprodan.mlx-serve.plist` is written
   with the versioned binary path and the flags from the configuration,
   and the job is started.
4. The install counts only when launchd reports the job running from that
   path with a pid that stays the same, and `/health` answers.

An upgrade runs steps 1 and 2 while the old build keeps serving, so a
failed download costs nothing. Cancel works until the swap begins. The
engine is down from the swap until the new build answers, and the first
request afterwards loads the model again. If the new build does not come
up, the previous one is restored and the row says why.

Two builds are kept: the active one and the previous one. Rollback
returns to the previous build and removes the one it leaves. Uninstall
removes the LaunchAgent and the builds. Models, the engine's caches and
its logs under `~/.mlx-serve/` are never touched.

If 1ctx-mlx-engine stops in the middle of a swap, it finishes or undoes the swap
the next time it starts, and logs which.

## Configuration

| Row | Fields | Flags |
|---|---|---|
| Listener | host (`127.0.0.1` or `0.0.0.0`), port | `--host`, `--port` |
| Model dirs | one to eight directories, created if missing; 1ctx-mlx-engine's own download directory stays in the list | `--model-dir` |
| Prefix cache | memory and disk per resident model, entries | `--prefix-cache-mem`, `--prefix-cache-disk`, `--prefix-cache-entries` |
| Residency | models, memory, context, idle evict | `--max-resident-models`, `--max-resident-mem`, `--ctx-size`, `--idle-evict-secs` |
| Sampling | temp, top-p, top-k; blank leaves each model's own | `--temp`, `--top-p`, `--top-k` |
| Decoding | KV quant, MTP, prompt lookup, no vision | `--kv-quant`, `--mtp`, `--no-pld`, `--no-vision` |
| Log level | | `--log-level` |
| Extra args | one per line, passed as they are | anything else in `mlx-serve serve --help` |

`--serve` and `--metrics` are always passed, because 1ctx-mlx-engine reads the
engine through them. The port must be the one 1ctx-mlx-engine watches; to change
it, change `--engine` with `1ctx-mlx-engine service install`. A loopback bind is
refused when 1ctx-mlx-engine reaches the engine by another address. Extra
arguments may not repeat a field above or name `--serve`, `--metrics`,
`--host`, `--port`, `--model-dir`, `--log-file`, `--api-key` or
`--api-key-env`.

A hand edit to the LaunchAgent is overwritten by the next Apply.

## Logs

The engine has two log files, and they carry different things:

- `~/.mlx-serve/logs/mlx-serve-<port>.log` is the per-request log the
  engine writes itself. It rotates to `.1` at 32 MB.
- `~/.mlx-serve/logs/launchd.log` is its standard output and error:
  memory limits at start, model evictions, and the reason when it cannot
  start. 1ctx-mlx-engine rotates it at 8 MB whenever it restarts the job, and a
  failed install or Apply shows its tail.

## Access

The management routes are not authenticated. Anyone who can reach
1ctx-mlx-engine's listener can use them, as they can already load and unload
models. Bind 1ctx-mlx-engine to an address only trusted machines can reach.
