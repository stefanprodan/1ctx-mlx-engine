// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The page head, 1ctx's crumb under the 1ctx root: stuck to the top of the window over the
// page column, with a shadow once the page has scrolled under it.

import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { follow, PAGES, type Page } from "../store.ts";

export function Head({ page }: { page: Page }) {
  const stuck = useSignal(false);
  useEffect(() => {
    const onScroll = () => {
      stuck.value = scrollY > 2;
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  const p = PAGES.find((x) => x.page === page) ?? PAGES[0];
  return (
    <div class={`page-head${stuck.value ? " page-head-stuck" : ""}`}>
      <div class="page-head-in">
        <div class="crumb">
          {/* the root goes home, the Overview; a modified click stays a
              browser link */}
          <a class="crumb-home" href="/" onClick={(e) => follow(e, "/")}>
            1ctx
          </a>
          <span class="crumb-sep">/</span>
          {p.section && (
            <>
              <span>{p.section}</span>
              <span class="crumb-sep">/</span>
            </>
          )}
          <span class="crumb-page">{p.label}</span>
        </div>
      </div>
    </div>
  );
}
