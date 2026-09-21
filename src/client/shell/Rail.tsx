// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// 1ctx's rail, as the engine needs it: the logo with the button that
// folds it, every page as a row (Overview and Requests under Monitor),
// and the user row at the bottom with its menu. Folded on a wide window
// it is a strip with the pages as icons. Below 720 it is a full screen
// opened by a button that floats over the page; while it is open the
// page under it is inert, and the focus comes back to that button when
// it closes.

import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { GitHub, Icon, type IconName, Logo } from "../icons.tsx";
import { restartBlocked, runAction } from "../monitor/actions.ts";
import { busy, PAGES, type Page } from "../store.ts";
import {
  closeDrawer,
  drawerOpen,
  hideRail,
  narrow,
  openDrawer,
  railHidden,
  showRail,
} from "./shell.ts";
import "./shell.css";
import "./rail.css";

const ICON: Record<Page, IconName> = {
  monitor: "grid",
  requests: "swap",
  engine: "chip",
  benchmark: "gauge",
};

const SOURCE = "https://github.com/stefanprodan/1ctx-mlx-engine";

const current = (on: boolean) => (on ? "page" : undefined);

// the user row's two items: the engine's restart, with the Runtime
// head's rule, and the link to the source
export function UserMenu({ close }: { close: () => void }) {
  const blocked = restartBlocked.value;
  return (
    <div class="rail-menu" role="menu">
      <button
        type="button"
        class="rail-menu-item"
        role="menuitem"
        disabled={blocked !== "" || busy.value !== null}
        title={blocked || undefined}
        onClick={() => {
          close();
          // the dialog is in the page, which is inert under the drawer
          closeDrawer();
          void runAction("free", null);
        }}
      >
        <Icon name="redo" size={14} />
        <span>Restart engine</span>
      </button>
      <a
        class="rail-menu-item"
        role="menuitem"
        href={SOURCE}
        target="_blank"
        rel="noopener"
        onClick={close}
      >
        <GitHub />
        <span>Source code</span>
      </a>
    </div>
  );
}

// the user row, hardcoded, its menu opened upward; Escape or a click
// outside closes it
function User() {
  const open = useSignal(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open.value) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open.value = false;
    };
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) open.value = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [open.value]);
  return (
    <div class="rail-user" ref={box}>
      {open.value && (
        <UserMenu
          close={() => {
            open.value = false;
          }}
        />
      )}
      <button
        type="button"
        class="rail-user-row"
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        <span class="avatar">AD</span>
        <span class="rail-user-name">Admin</span>
        <Icon name="chevron" size={14} class="rail-user-chevron" />
      </button>
    </div>
  );
}

export function Rail({ page }: { page: Page }) {
  const drawer = narrow.value;
  const hide = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (drawer) hide.current?.focus();
  }, [drawer]);
  // a link on a phone closes the drawer, the one to the page shown too
  const follow = drawer ? closeDrawer : undefined;
  const inMonitor = PAGES.some((p) => p.section && p.page === page);
  return (
    <aside class={`rail${drawer ? " rail-drawer" : ""}`}>
      <div class="rail-top">
        <div class="rail-head">
          <a class="rail-logo" href="/" aria-label="Overview" onClick={follow}>
            <Logo height={26} />
            <span class="rail-word">MLX</span>
          </a>
          <button
            ref={hide}
            type="button"
            class="rail-btn rail-hide"
            aria-label={drawer ? "Close the menu" : "Hide the menu"}
            onClick={drawer ? closeDrawer : hideRail}
          >
            <Icon name={drawer ? "close" : "sidebar"} />
          </button>
        </div>
        <nav class="rail-nav">
          <div class={`rail-item rail-label${inMonitor ? " rail-in" : ""}`}>
            <Icon name="pulse" />
            <span>Monitor</span>
          </div>
          {PAGES.map((p) =>
            p.section ? (
              <a
                key={p.page}
                href={p.href}
                class={`rail-sub${p.page === page ? " rail-sub-on" : ""}`}
                aria-current={current(p.page === page)}
                onClick={follow}
              >
                <Icon name={ICON[p.page]} size={14} />
                <span>{p.label}</span>
              </a>
            ) : (
              <a
                key={p.page}
                href={p.href}
                class={`rail-item${p.page === page ? " rail-item-on" : ""}`}
                aria-current={current(p.page === page)}
                onClick={follow}
              >
                <Icon name={ICON[p.page]} />
                <span>{p.label}</span>
              </a>
            ),
          )}
        </nav>
      </div>
      <User />
    </aside>
  );
}

// the folded rail: the button that brings it back, then the pages as
// icons, Monitor's above a rule and the rest below, as the rail groups
// them
export function Strip({ page }: { page: Page }) {
  const link = (p: (typeof PAGES)[number]) => (
    <a
      key={p.page}
      href={p.href}
      class={`strip-icon${p.page === page ? " strip-icon-on" : ""}`}
      title={p.label}
      aria-label={p.label}
      aria-current={current(p.page === page)}
    >
      <Icon name={ICON[p.page]} />
    </a>
  );
  return (
    <aside class="strip">
      <button
        type="button"
        class="rail-btn"
        aria-label="Show the menu"
        onClick={showRail}
      >
        <Icon name="sidebar" />
      </button>
      <nav class="strip-nav">
        {PAGES.filter((p) => p.section).map(link)}
        <span class="strip-rule" />
        {PAGES.filter((p) => !p.section).map(link)}
      </nav>
    </aside>
  );
}

// the rail, the strip or the floating button, whichever the window and
// the choice call for
export function Side({ page }: { page: Page }) {
  const phone = narrow.value;
  const covered = phone && drawerOpen.value;
  const show = useRef<HTMLButtonElement>(null);
  const wasCovered = useRef(false);
  useEffect(() => {
    if (!covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [covered]);
  useEffect(() => {
    if (wasCovered.current && !covered) show.current?.focus();
    wasCovered.current = covered;
  }, [covered]);
  if (covered) return <Rail page={page} />;
  if (phone) {
    return (
      <button
        ref={show}
        type="button"
        class="rail-btn rail-float"
        aria-label="Show the menu"
        onClick={openDrawer}
      >
        <Icon name="sidebar" />
      </button>
    );
  }
  return railHidden.value ? <Strip page={page} /> : <Rail page={page} />;
}
