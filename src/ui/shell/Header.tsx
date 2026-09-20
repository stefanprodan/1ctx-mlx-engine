// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0

import { Mark } from "../icons.tsx";
import type { Page } from "../store.ts";

const PAGES: { page: Page; href: string; label: string }[] = [
  { page: "monitor", href: "/", label: "Monitor" },
  { page: "requests", href: "/requests", label: "Requests" },
];

// The wordmark and the nav; each page carries the connection pill in its
// own section head.
export function Header({ page }: { page: Page }) {
  return (
    <>
      <div class="wordmark">
        <Mark />
        MLX Spy
      </div>
      <nav class="menu">
        {PAGES.map((p) => (
          <a
            key={p.page}
            href={p.href}
            class={p.page === page ? "active" : undefined}
          >
            {p.label}
          </a>
        ))}
      </nav>
    </>
  );
}
