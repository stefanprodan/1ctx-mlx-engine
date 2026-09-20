// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { version } from "../store.ts";

export function Footer() {
  const v = version.value;
  return (
    <>
      <a
        class="footlink"
        href="https://github.com/stefanprodan/1ctx-mlx-engine"
        target="_blank"
        rel="noopener"
      >
        {v ? `1ctx-mlx-engine ${v}` : "1ctx-mlx-engine"}
      </a>
      <span class="grow" />
      <span>
        &copy; 2026{" "}
        <a
          class="footlink"
          href="https://stefanprodan.com"
          target="_blank"
          rel="noopener"
        >
          Stefan Prodan
        </a>
      </span>
    </>
  );
}
