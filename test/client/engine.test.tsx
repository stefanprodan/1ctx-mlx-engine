// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "bun:test";
import { render } from "preact-render-to-string";
import { Build } from "../../src/client/engine/Build.tsx";
import { Config, ConfigHead } from "../../src/client/engine/Config.tsx";
import {
  changedFields,
  refusalLine,
  toConfig,
  toForm,
} from "../../src/client/engine/config.ts";
import {
  cancellable,
  idleLine,
  lockedWhy,
  phaseLine,
  progressPct,
  servicePill,
} from "../../src/client/engine/release.ts";
import { Self, SelfHead, UPGRADE } from "../../src/client/engine/Self.tsx";
import { ServiceHead } from "../../src/client/engine/Service.tsx";
import {
  changed,
  edit,
  form,
  issues,
  resetEngineState,
  revert,
  setPageState,
} from "../../src/client/engine/state.ts";
import type {
  EngineConfig,
  EnginePageState,
  EngineState,
  Operation,
  Release,
} from "../../src/shared/engine.ts";
import { abbreviateHome, expandHome } from "../../src/shared/paths.ts";
import { sample, startedAt } from "./helpers.ts";

const HOME = "/Users/me";
const PINNED = `${HOME}/models`;

const config = (over: Partial<EngineConfig> = {}): EngineConfig => ({
  host: "127.0.0.1",
  port: 11234,
  modelDirs: [PINNED],
  prefixCacheMem: null,
  prefixCacheDisk: null,
  prefixCacheEntries: null,
  maxResidentModels: null,
  maxResidentMem: null,
  ctxSize: null,
  idleEvictSeconds: null,
  temp: null,
  topP: null,
  topK: null,
  kvQuant: "off",
  mtp: false,
  pld: true,
  noVision: false,
  logLevel: "info",
  extraArgs: [],
  ...over,
});

const release = (over: Partial<Release> = {}): Release => ({
  tag: "v26.9.4",
  version: "26.9.4",
  prerelease: false,
  publishedAt: "2026-09-17T10:00:00Z",
  assetBytes: 72_100_000,
  ...over,
});

const engineState = (over: Partial<EngineState> = {}): EngineState => ({
  mode: "managed",
  refusal: null,
  remoteHost: null,
  active: {
    tag: "v26.9.3",
    version: "26.9.3",
    mlx: "0.32.2",
    installedAt: startedAt,
  },
  previous: {
    tag: "v26.9.2",
    version: "26.9.2",
    mlx: "0.32.2",
    installedAt: startedAt,
  },
  service: {
    state: "running",
    pid: 4242,
    lastExitCode: null,
    readAt: startedAt,
  },
  config: config(),
  defaults: config(),
  pinnedModelDir: PINNED,
  watchedPort: 11234,
  home: HOME,
  preReleases: false,
  check: { releases: [release()], checkedAt: startedAt, error: null },
  offered: release(),
  operation: null,
  failure: null,
  ...over,
});

const pageState = (over: Partial<EngineState> = {}): EnginePageState => ({
  engine: engineState(over),
  self: {
    version: "v0.1.0",
    startedAt: startedAt - 3_600_000,
    rssBytes: 84 * 2 ** 20,
    cpuPct: 0.6,
    check: { releases: [], checkedAt: startedAt, error: null },
    offered: null,
  },
});

const op = (over: Partial<Operation> = {}): Operation => ({
  kind: "upgrade",
  tag: "v26.9.4",
  phase: "downloading",
  doneBytes: 41_200_000,
  totalBytes: 72_100_000,
  bytesPerSecond: 12_100_000,
  ...over,
});

const disabledCount = (html: string) => (html.match(/ disabled/g) ?? []).length;

beforeEach(resetEngineState);

describe("the form model", () => {
  test("paths are shown with ~ and stored absolute", () => {
    expect(abbreviateHome(PINNED, HOME)).toBe("~/models");
    expect(abbreviateHome("/Volumes/x", HOME)).toBe("/Volumes/x");
    expect(abbreviateHome(`${HOME}er/x`, HOME)).toBe(`${HOME}er/x`);
    expect(expandHome("~/models", HOME)).toBe(`${HOME}/models`);
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome(" /abs ", HOME)).toBe("/abs");
  });

  test("a config survives the round trip through the form", () => {
    const full = config({
      host: "0.0.0.0",
      modelDirs: [PINNED, `${HOME}/models`],
      prefixCacheMem: "16GB",
      prefixCacheDisk: "50GB",
      maxResidentModels: 2,
      idleEvictSeconds: 3600,
      temp: 1,
      topP: 0.95,
      topK: 0,
      mtp: true,
      extraArgs: ["--skip-mem-preflight", "--pld-draft-len 5"],
    });
    const out = toConfig(toForm(full, HOME), HOME);
    expect(out.issues).toEqual([]);
    expect(out.config).toEqual(full);
  });

  test("a blank stays null and text that is not a number is refused", () => {
    const f = toForm(config(), HOME);
    const out = toConfig(
      { ...f, temp: "warm", maxResidentModels: "1.5", port: "" },
      HOME,
    );
    expect(out.config.topP).toBeNull();
    expect(out.issues).toEqual([
      { field: "maxResidentModels", message: "Not a whole number." },
      { field: "temp", message: "Not a number." },
      { field: "port", message: "A port is required." },
    ]);
  });

  test("changed fields name the inputs, a directory by its row", () => {
    const applied = toForm(config({ modelDirs: [PINNED, "/a"] }), HOME);
    expect(changedFields(applied, applied).size).toBe(0);
    const edited = {
      ...applied,
      prefixCacheMem: "24GB",
      mtp: true,
      modelDirs: ["~/models", "/b", ""],
    };
    expect([...changedFields(edited, applied)].sort()).toEqual([
      "modelDirs",
      "modelDirs.1",
      "mtp",
      "prefixCacheMem",
    ]);
  });

  test("the refusal line counts fields", () => {
    expect(refusalLine([{ field: "port", message: "x" }], "Apply")).toBe(
      "Apply was refused. 1 field needs fixing.",
    );
    expect(
      refusalLine(
        [
          { field: "port", message: "x" },
          { field: "temp", message: "y" },
        ],
        "Install",
      ),
    ).toBe("Install was refused. 2 fields need fixing.");
  });
});

describe("the row copy", () => {
  test("phases, the bar and where Cancel ends", () => {
    expect(phaseLine(op())).toBe("downloading, 41.2 of 72.1 MB, 12.1 MB/s");
    expect(Math.round(progressPct(op()))).toBe(57);
    expect(cancellable(op())).toBe(true);
    const swap = op({ phase: "restarting" });
    expect(phaseLine(swap)).toBe("restarting mlx-serve");
    expect(progressPct(swap)).toBe(100);
    expect(cancellable(swap)).toBe(false);
    expect(cancellable(op({ kind: "apply" }))).toBe(false);
    expect(lockedWhy(op())).toBe("locked while mlx-serve is being upgraded");
  });

  test("a row with nothing to offer still says something", () => {
    const none = { releases: [], checkedAt: null, error: null };
    expect(idleLine(none, true)).toBe("Checking for releases");
    expect(idleLine({ ...none, checkedAt: 1 }, true)).toBe("No releases found");
    expect(idleLine({ ...none, error: "HTTP 403" }, true)).toBe(
      "Release check failed",
    );
    expect(
      idleLine({ releases: [release()], checkedAt: 1, error: null }, true),
    ).toBe("Up to date");
  });

  test("the pill follows the mode, launchd and the swap", () => {
    const s = sample({ engineStartedAt: startedAt - 7_200_000 });
    expect(servicePill(engineState(), s).cls).toBe("pill live");
    expect(servicePill(engineState({ mode: "remote" }), s).text).toBe("remote");
    expect(servicePill(engineState({ mode: "unmanaged" }), s).text).toBe(
      "unmanaged",
    );
    expect(servicePill(engineState({ mode: "absent" }), null)).toEqual({
      cls: "pill err",
      text: "not installed",
    });
    const crashed = engineState({
      service: {
        state: "crashed",
        pid: null,
        lastExitCode: 1,
        readAt: startedAt,
      },
    });
    expect(servicePill(crashed, s).text).toBe("crashed, exit 1");
    const swap = engineState({ operation: op({ phase: "restarting" }) });
    expect(servicePill(swap, s)).toEqual({
      cls: "pill warn",
      text: "restarting",
    });
  });
});

describe("the sections", () => {
  const s = sample({ enginePid: 4242, engineCpuPct: 0.2 });

  test("managed: build, Rollback, the update row and a quiet Apply", () => {
    setPageState(pageState());
    const e = engineState();
    const build = render(
      <Build engine={e} s={s} url="http://127.0.0.1:11234" sampledVersion="" />,
    );
    expect(build).toContain("26.9.3<small>MLX 0.32.2</small>");
    expect(build).toContain(">Rollback</button>");
    expect(build).toContain("Update available");
    // the version opens the release on GitHub in a new tab
    expect(build).toContain(
      '<a class="ver" href="https://github.com/ddalcu/mlx-serve/releases/tag/v26.9.4" target="_blank" rel="noopener" title="Release notes on GitHub">26.9.4</a>',
    );
    expect(build).toContain("72.1 MB, 17 September");
    expect(build).toContain("include pre-releases");
    expect(build).toContain("127.0.0.1:11234");
    const head = render(<ServiceHead engine={e} s={s} />);
    expect(head).toContain(">Stop</button>");
    expect(head).toContain(">Restart</button>");
    expect(head).not.toContain(">Start</button>");
    expect(render(<ConfigHead engine={e} />)).toContain(
      '<span class="pill live">applied</span>',
    );
    const cfg = render(<Config engine={e} />);
    expect(cfg).toContain("No changes.");
    // Apply and Revert wait for a change; the pinned directory has no
    // remove button
    expect(disabledCount(cfg)).toBe(2);
    expect(cfg).toContain('value="~/models"');
    expect(cfg).not.toContain("Remove model directory 1");
    expect(cfg).toContain('placeholder="auto"');
  });

  test("dirty: the pill, the outline and the cost, stated once", () => {
    setPageState(pageState());
    edit({ prefixCacheMem: "24GB" });
    expect(changed.value.has("prefixCacheMem")).toBe(true);
    const e = engineState();
    expect(render(<ConfigHead engine={e} />)).toContain(
      '<span class="pill warn">edited</span>',
    );
    const cfg = render(<Config engine={e} />);
    expect(cfg).toContain('class="w5 changed"');
    expect(cfg).toContain("Applying restarts mlx-serve.");
    expect(disabledCount(cfg)).toBe(0);
  });

  test("invalid: the field says why, next to itself", () => {
    setPageState(pageState());
    edit({ port: "11500" });
    issues.value = [
      {
        field: "port",
        message:
          "1ctx-mlx-engine is watching port 11234. Change where it looks with 1ctx-mlx-engine service install --engine.",
      },
    ];
    const cfg = render(<Config engine={engineState()} />);
    expect(cfg).toContain('aria-invalid="true"');
    expect(cfg).toContain('aria-describedby="cfg-bad-port"');
    expect(cfg).toContain(
      '<small class="bad" id="cfg-bad-port">1ctx-mlx-engine is watching port 11234',
    );
  });

  test("absent: dashes, no service buttons, Install by the release", () => {
    const over = {
      mode: "absent" as const,
      active: null,
      previous: null,
      service: null,
    };
    setPageState(pageState(over));
    const e = engineState(over);
    const build = render(
      <Build
        engine={e}
        s={sample({ engineUp: false })}
        url=""
        sampledVersion=""
      />,
    );
    expect(build).toContain("Latest release");
    expect(build).toMatch(
      /<button[^>]*aria-describedby="install-why"[^>]*>Install<\/button>/,
    );
    expect(build).not.toMatch(/ disabled[^>]*>Install</);
    expect(build).not.toContain(">Upgrade</button>");
    expect(build).not.toContain("Rollback");
    const head = render(<ServiceHead engine={e} s={null} />);
    expect(head).toContain("not installed");
    expect(head).not.toContain("<button");
    expect(render(<ConfigHead engine={e} />)).not.toContain("pill");
    const cfg = render(<Config engine={e} />);
    // the foot says what Install does; the button is up by the release
    expect(cfg).toContain('id="install-why"');
    expect(cfg).toContain("Install uses these settings.");
    expect(cfg).not.toContain(">Install</button>");
    expect(cfg).not.toContain(">Apply</button>");
  });

  test("unmanaged: the sampler's facts, and Install refused in words", () => {
    const refusal =
      "Port 11234 is in use by an mlx-serve that 1ctx-mlx-engine did not install. Stop it first.";
    const over = {
      mode: "unmanaged" as const,
      refusal,
      active: null,
      previous: null,
      service: null,
    };
    setPageState(pageState(over));
    const e = engineState(over);
    const build = render(
      <Build
        engine={e}
        s={s}
        url="http://127.0.0.1:11234"
        sampledVersion="26.9.1"
      />,
    );
    expect(build).toContain("26.9.1");
    expect(build).not.toContain("MLX 0.32.2");
    expect(render(<ServiceHead engine={e} s={s} />)).toContain("unmanaged");
    expect(build).toMatch(/<button[^>]* disabled[^>]*>Install<\/button>/);
    expect(render(<Config engine={e} />)).toContain(refusal);
  });

  test("an operation locks every mutating control, 1ctx-mlx-engine's too", () => {
    const over = { operation: op() };
    setPageState(pageState(over));
    const e = engineState(over);
    const build = render(
      <Build engine={e} s={s} url="http://127.0.0.1:11234" sampledVersion="" />,
    );
    expect(build).toContain("Upgrading to");
    expect(build).toContain("downloading, 41.2 of 72.1 MB, 12.1 MB/s");
    // Rollback is off, Cancel is the one live control
    expect(build).toMatch(/<button[^>]* disabled[^>]*>Rollback<\/button>/);
    expect(build).toMatch(/<button type="button" class="btn danger">Cancel/);
    const head = render(<ServiceHead engine={e} s={s} />);
    expect(disabledCount(head)).toBe(3);
    expect(
      render(<SelfHead self={pageState().self} now={startedAt} />),
    ).toMatch(/<button[^>]* disabled[^>]*>Restart<\/button>/);
    const cfgHead = render(<ConfigHead engine={e} />);
    expect(cfgHead).toContain("read-only");
    expect(cfgHead).toContain("locked while mlx-serve is being upgraded");
    const cfg = render(<Config engine={e} />);
    expect(cfg).not.toMatch(/<(input|select|textarea)(?![^>]* disabled)[^>]*>/);
    // the selects are buttons: all three, and none of them live
    expect(cfg.match(/<button[^>]* role="combobox"[^>]*>/g)).toHaveLength(3);
    expect(cfg).not.toMatch(/<button(?![^>]* disabled)[^>]* role="combobox"/);
  });

  test("stopped: Start, no numbers; a stale stopped yields to the sampler", () => {
    const over = {
      service: {
        state: "stopped" as const,
        pid: null,
        lastExitCode: 0,
        readAt: startedAt,
      },
    };
    setPageState(pageState(over));
    const e = engineState(over);
    const down = sample({ engineUp: false, enginePid: null });
    const head = render(<ServiceHead engine={e} s={down} />);
    expect(head).toContain('<span class="pill">stopped</span>');
    expect(head).toContain(">Start</button>");
    expect(head).not.toContain(">Stop</button>");
    expect(
      render(<Build engine={e} s={down} url="" sampledVersion="" />),
    ).not.toContain("<small>CPU</small>");
    // launchd's cached answer is old: the engine is up, so the page says
    // up everywhere, never "stopped" beside live numbers
    const live = render(<ServiceHead engine={e} s={s} />);
    expect(live).not.toContain("stopped");
    expect(live).toContain(">Stop</button>");
  });

  test("restarting: Cancel is off too", () => {
    const over = { operation: op({ phase: "restarting" }) };
    setPageState(pageState(over));
    const build = render(
      <Build engine={engineState(over)} s={s} url="" sampledVersion="" />,
    );
    expect(build).toContain("restarting mlx-serve");
    expect(build).toMatch(/<button[^>]* disabled[^>]*>Cancel<\/button>/);
  });

  test("failed: the reason and the log tail have a place", () => {
    const over = {
      failure: {
        kind: "upgrade" as const,
        tag: "v26.9.4",
        message: "mlx-serve did not stay up on 26.9.4",
        outcome: "rolled back to 26.9.3, serving again",
        logTail: "bind 0.0.0.0:11234: address already in use",
        at: startedAt,
      },
    };
    setPageState(pageState(over));
    const build = render(
      <Build engine={engineState(over)} s={s} url="" sampledVersion="" />,
    );
    expect(build).toContain('class="notice bad" role="alert"');
    expect(build).toContain("Upgrade to 26.9.4 failed");
    expect(build).toContain("rolled back to 26.9.3, serving again");
    expect(build).toContain('<pre class="tail">bind 0.0.0.0:11234');
    expect(build).toContain(">Dismiss</button>");
    expect(build).toContain(">Try again</button>");
  });

  test("remote: no config card, a dash for CPU, 1ctx-mlx-engine stays live", () => {
    const over = {
      mode: "remote" as const,
      remoteHost: "studio.example.ts.net",
      active: null,
      previous: null,
      service: null,
    };
    setPageState(pageState(over));
    const e = engineState(over);
    const remote = sample({ enginePid: null, engineCpuPct: null });
    remote.mem = { ...remote.mem, procFootprint: 38.2 * 2 ** 30 };
    const build = render(
      <Build
        engine={e}
        s={remote}
        url="http://studio.example.ts.net:11234"
        sampledVersion="26.9.3"
      />,
    );
    expect(build).toContain("38.2 GB <small>MEM</small> / –");
    expect(build).toContain("This one is at studio.example.ts.net.");
    expect(build).not.toContain("include pre-releases");
    expect(render(<ServiceHead engine={e} s={remote} />)).not.toContain(
      "<button",
    );
    const cfg = render(<Config engine={e} />);
    expect(cfg).toContain("not 1ctx-mlx-engine's to read or write");
    expect(cfg).not.toContain("<input");
    expect(
      render(<SelfHead self={pageState().self} now={startedAt} />),
    ).not.toMatch(/ disabled/);
  });

  test("1ctx-mlx-engine: only a dev build says so", () => {
    const dev = { ...pageState().self, version: "v0.0.0-dev" };
    expect(render(<Self self={dev} />)).toContain("<small>dev build</small>");
    const deployed = { ...dev, version: "v0.0.0-dev+1a2b3c4.dirty5d6e7f" };
    expect(render(<Self self={deployed} />)).toContain(
      "<small>dev build</small>",
    );
    expect(render(<Self self={pageState().self} />)).not.toContain("dev build");
  });

  test("1ctx-mlx-engine: the update command is text", () => {
    const self = {
      ...pageState().self,
      offered: release({ tag: "v0.2.0", version: "0.2.0" }),
    };
    const html = render(<Self self={self} />);
    expect(html).toContain(
      "84 MB <small>MEM</small> / 0.6% <small>CPU</small>",
    );
    expect(html).toContain(`<code class="cmd">${UPGRADE}</code>`);
    expect(html).toContain(
      '<a class="ver" href="https://github.com/stefanprodan/1ctx-mlx-engine/releases/tag/v0.2.0" target="_blank" rel="noopener" title="Release notes on GitHub">v0.2.0</a>',
    );
    expect(html).toContain('aria-label="Copy the install command"');
  });

  test("an edit survives every push, another tab's Apply included", () => {
    setPageState(pageState());
    edit({ temp: "0.7" });
    setPageState(pageState({ operation: op() }));
    expect(form.value?.temp).toBe("0.7");
    // another tab applied something else: the baseline moves, the text
    // someone is typing does not, and Revert lands on the new baseline
    setPageState(pageState({ config: config({ temp: 0.5, topK: 40 }) }));
    expect(form.value?.temp).toBe("0.7");
    expect([...changed.value].sort()).toEqual(["temp", "topK"]);
    revert();
    expect(form.value?.temp).toBe("0.5");
    expect(form.value?.topK).toBe("40");
    // with no edit in hand the form follows
    setPageState(pageState({ config: config({ temp: 0.9 }) }));
    expect(form.value?.temp).toBe("0.9");
  });
});
