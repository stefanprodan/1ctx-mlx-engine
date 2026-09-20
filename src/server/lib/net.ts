// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The port 1ctx-mlx-engine listens on and the tailnet address it prints,
// shared by the CLI, the service installer and the server.

import { networkInterfaces } from "node:os";

export const DEFAULT_PORT = 11235;

export function tailscaleAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const address of addrs ?? []) {
      if (address.family !== "IPv4") continue;
      const [o1, o2] = address.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return address.address;
    }
  }
  return null;
}
