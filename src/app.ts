// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Actions } from "./actions.ts";
import { type Options, VERSION } from "./cli.ts";
import { cacheLimits } from "./engine/config.ts";
import { MlxServe } from "./engine/mlxserve.ts";
import { History } from "./history.ts";
import { createHostProbes } from "./host/index.ts";
import { hostInfo } from "./host/info.ts";
import { isLocalUrl } from "./host/local.ts";
import { createLog } from "./log.ts";
import { PullRunner } from "./pull.ts";
import { PullStore } from "./pulls.ts";
import { takeSample } from "./sample.ts";
import { Sampler } from "./sampler.ts";
import { loadKey, secretsDir } from "./secrets.ts";
import page from "./ui/index.html";
import { DEFAULT_PORT, serve, tailscaleAddress } from "./web.ts";

// Rates need two readings; one second matches the sampler's tick.
const ONCE_WINDOW_MS = 1000;

export class AppError extends Error {}

export async function runApp(options: Options): Promise<number | undefined> {
  const engine = new MlxServe(options.engineUrl);
  const probes = await createHostProbes();
  const local = isLocalUrl(options.engineUrl);

  if (options.once) {
    const sample = await takeSample(engine, ONCE_WINDOW_MS, probes);
    console.log(JSON.stringify(sample, null, 2));
    return sample.engineUp ? 0 : 2;
  }

  let hostname = tailscaleAddress() ?? "127.0.0.1";
  let port = DEFAULT_PORT;
  if (options.listen) {
    if (options.listen.hostname) hostname = options.listen.hostname;
    if (options.listen.port !== null) port = options.listen.port;
  }

  const log = createLog();

  // A bad key file fails loud and plain without unrelated usage text.
  const keyDir = secretsDir();
  let hubToken: string | null;
  try {
    hubToken = loadKey(join(keyDir, "hf.key"));
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : String(error));
  }
  log(`hf key: ${hubToken === null ? "none" : join(keyDir, "hf.key")}`);

  if (options.dbPath !== ":memory:") {
    mkdirSync(dirname(options.dbPath), { recursive: true });
  }
  const history = new History(options.dbPath, options.retentionDays);
  const sampler = new Sampler(engine, history, { log, probes, local });
  const currentLimits = () => {
    const label = local ? engine.serviceLabel() : null;
    const plistLimits = label ? cacheLimits(label) : null;
    return options.hotMax !== null || options.diskMax !== null || plistLimits
      ? {
          hotBytes: options.hotMax ?? plistLimits?.hotBytes ?? 0,
          diskBytes: options.diskMax ?? plistLimits?.diskBytes ?? 0,
        }
      : sampler.currentLimits();
  };
  const actions = new Actions({ engine, sampler, history, local, log });
  const pulls = new PullRunner({
    store: new PullStore(history.db),
    modelDir: options.modelDir,
    token: hubToken,
    engine,
    refreshModels: () => sampler.refreshModels(),
    log,
  });
  const web = serve(
    {
      engine,
      sampler,
      history,
      actions,
      pulls,
      version: VERSION,
      local,
      currentLimits,
      host: await hostInfo(),
      modelDir: options.modelDir,
    },
    { hostname, port },
    page,
  );
  sampler.start();
  pulls.resume();
  log(
    `mlx-spy ${VERSION} on http://${web.server.hostname}:${web.server.port}, engine ${options.engineUrl} (${local ? "local" : "remote"}), history ${options.dbPath}, models ${options.modelDir}`,
  );

  const shutdown = () => {
    sampler.stop();
    pulls.shutdown();
    web.stop();
    history.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
