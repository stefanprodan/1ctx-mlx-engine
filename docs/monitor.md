# Monitor and Requests

The rail on the left lists every page: Overview (`/`) and Requests
(`/requests`) under Monitor, Models (`/models`) and Server (`/server`)
under Engine, then Run (`/benchmark`) and Scorecard
(`/benchmark/scorecard`) under Benchmark. The button at its
top folds it to a strip of the same pages as icons, and the page
remembers that choice. On a phone the rail opens full screen from the
button at the top left. The head over each page names it and stays put
while the page scrolls. Server carries a `new` pill (a dot on its icon in
the strip) while the Server page offers a newer mlx-serve or
1ctx-mlx-engine; the pill's tooltip names the versions. The Admin menu at
the rail's foot restarts the engine, switches the theme and links to the
source. The theme follows the system until the switch picks the other
one; the browser keeps that choice, and a switch back to the system's
theme forgets it.

## Overview

The Overview page is the engine at a glance, one sample per second, with
seven days of history in SQLite so every tab and every reload shows the
same series.

On a host with no mlx-serve installed the page says so: the Models and
Runtime pills read `not installed` where a stopped engine reads
`unreachable` and `offline`, the request bar reads `no engine`, Restart
engine is off, and the Models card links to the Server page. A visit that
lands on `/` from outside goes to the Server page directly; Overview in
the rail still opens it.

- **Tiles**: requests served, tokens generated, prefill and decode tok/s,
  cache efficiency, memory, RAM cache and SSD cache. The cache tiles draw
  a bar against the engine's per-model budgets, read from its launchd
  plist when the engine is local or given with `--hot-cache-max` and
  `--disk-cache-max`. A value with nothing behind it (no request in the
  range, a probe that needs a local engine) is a dimmed dash; counts stay
  at 0. The line under a value is a related fact or empty, so the tiles
  keep their size when the engine is idle.
- **Charts** with a shared cursor and a 1h, 6h, 24h, 7d range picker. The
  1h range is raw seconds and grows live; longer ranges are bucket
  averages, re-fetched every minute.
- **The request bar**: the request in flight (start time, tokens so far,
  time spent prefilling and decoding) or the last one finished with its
  prompt size and cached share.
- **Models** (or "No models found." and "Engine unreachable." as one line when
  there are none): every model the engine lists, the daily driver first and
  the rest by id so nothing moves on a load, with its state, size and
  context, and the buttons: load, unload, make default, delete, plus the
  daily-driver star (1ctx-mlx-engine's own mark). Delete asks first and then
  removes the model from the model directory, along with the records of its
  downloads; it is there for an engine on this host and is disabled while
  the model is resident, because the weights are mapped until it is
  unloaded. The engine keeps listing a deleted model until it restarts, so
  the row stays, struck through and marked deleted, with load, delete and
  the star disabled (a deleted daily driver loses its star); downloading
  the model again clears the mark. A failed action is reported under the
  table; a success shows in the list or the uptime. Unload, the
  daily-driver toggle and a load into an empty
  engine run at once; loading next to a resident model asks first and
  shows the estimated engine memory after the load (its footprint now
  plus the model's weights); the rest ask for confirmation. Downloads
  start on the [Models page](models.md); one in progress is also a row at
  the top of this table with the bytes so far, the speed, the time left
  where the state would be, a delete button (asks first; stops the
  download and removes its files) and a pause button, which becomes
  resume once it stopped. A finished download becomes the model's own
  row once the engine lists it. A download that fails says why under the
  table.
- **Runtime**: the engine process (build, pid, RSS, CPU, GPU, weights)
  next to host facts (OS, chip, cores, GPU cores, memory, disk). The
  process probes only work when the engine runs on the same host. The build comes from
  the engine itself, asked once while a model is resident (asking an idle
  engine would make it load one), and kept in the database, so a restarted
  engine with nothing loaded still shows the build it last reported.

The engine reports counts, not requests: with several requests in flight
the bar and the tiles describe the engine as a whole.

## Requests

The Requests page moves the live bar over and lists the last 50 finished or
cancelled requests under it, in the same grid as the benchmark runs. A row
is the model (the engine does not say which one served it, so it is the
resident model, the favorite when several are resident) over a faint line
with the finish time, the prompt size and its cached share, then the time
to first token and the prefill and decode rates in tok/s. A cancelled
request says so in amber on that line. The search at the top of the card
narrows the rows to the models whose id contains what is typed, and All,
Completed and Cancelled pick by outcome. A row opens on a click to the
full model id and its figures in three groups: timing (start, finish,
time to first token, total), prefill (prompt, cached, time, rate) and
decode (generated, time, rate). A card too narrow for every column keeps
the two rates; the opened row has the rest. The bin in the History head
deletes the stored requests and the last request in the bar.

## Engine

The third page manages the engine itself: see [engine.md](engine.md).

## Benchmark

Run measures the engine on a scripted agent session, and the Scorecard
ranks the models it measured: see [benchmark.md](benchmark.md).

## Memory numbers

Memory is shown in binary GB, the unit About This Mac uses; only the host
disk is decimal, as Finder labels it. The precision follows the size:
whole GB from 10 up, one decimal below that, and MB under 1 GB, so a
small checkpoint reads `320 MB` and not `0 GB`. The engine's footprint is what it
reports itself; RSS comes from libproc when the engine is local. "RAM
cache" is an estimate: the MLX allocator's active bytes minus the loaded
weights, because the engine has no gauge for its hot prefix cache.
