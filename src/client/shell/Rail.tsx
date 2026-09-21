// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// 1ctx's rail, as the engine needs it: the logo with the button that
// folds it, every page as a row (Overview and Requests under Monitor,
// Models and Server under Engine, Run and Scorecard under Benchmark), and the user row at the bottom
// with its menu. Folded on a wide window it is a strip with the pages as
// icons. Below 720 it is a full screen
// opened by a button that floats over the page; while it is open the
// page under it is inert, and the focus comes back to that button when
// it closes.

import { useSignal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { GitHub, Icon, type IconName, Logo } from "../icons.tsx";
import { restartBlocked, runAction } from "../monitor/actions.ts";
import { busy, follow, PAGES, type Page, type Section } from "../store.ts";
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
  models: "cube",
  server: "server",
  run: "play",
  scorecard: "bars",
};

const SECTION_ICON: Record<Section, IconName> = {
  Monitor: "pulse",
  Engine: "chip",
  Benchmark: "gauge",
};

type Entry = (typeof PAGES)[number];

// the pages as the rail and the strip group them: a section's pages
// together where its first one is, wherever the others sit in PAGES, a
// page of no section alone
function groups(): Entry[][] {
  const out: Entry[][] = [];
  const bySection = new Map<Section, Entry[]>();
  for (const p of PAGES) {
    const group = p.section ? bySection.get(p.section) : undefined;
    if (group) {
      group.push(p);
      continue;
    }
    const fresh = [p];
    if (p.section) bySection.set(p.section, fresh);
    out.push(fresh);
  }
  return out;
}

const SOURCE = "https://github.com/stefanprodan/1ctx-mlx-engine";

const current = (on: boolean) => (on ? "page" : undefined);

// a fold or an unfold replaces the button that had the focus: the one
// that takes its place gets it
let refocus = false;

// the user row's two items: the engine's restart, with the Runtime
// head's rule, and the link to the source. The focus moves into the
// menu as it opens, and the arrows move it between the items
export function UserMenu({ close }: { close: () => void }) {
  const blocked = restartBlocked.value;
  const menu = useRef<HTMLDivElement>(null);
  const items = () =>
    [
      ...(menu.current?.querySelectorAll<HTMLElement>(".rail-menu-item") ?? []),
    ].filter((el) => !(el as HTMLButtonElement).disabled);
  useEffect(() => {
    items()[0]?.focus();
  }, []);
  const onKey = (e: KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % list.length
        : e.key === "ArrowUp"
          ? (at - 1 + list.length) % list.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? list.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    list[to]?.focus();
  };
  return (
    <div class="rail-menu" role="menu" ref={menu} onKeyDown={onKey}>
      <button
        type="button"
        class="rail-menu-item"
        role="menuitem"
        disabled={blocked !== "" || busy.value !== null}
        title={blocked || undefined}
        onClick={() => {
          close();
          // the dialog opens over the page the restart is about
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
        onClick={() => {
          close();
          // this tab is left showing the page, not the drawer over it
          closeDrawer();
        }}
      >
        <GitHub />
        <span>Source code</span>
      </a>
    </div>
  );
}

// the user row, hardcoded, its menu opened upward; a click outside
// closes it, and so does Escape, which goes no further: the drawer
// under the menu stays open
function User() {
  const open = useSignal(false);
  const box = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!open.value || !el) return;
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) open.value = false;
    };
    // on the box, before the drawer's listener on the document
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      open.value = false;
      row.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    el.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      el.removeEventListener("keydown", onKey);
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
        ref={row}
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
    if (drawer || refocus) hide.current?.focus();
    refocus = false;
  }, [drawer]);
  // a link swaps the page in place, and on a phone closes the drawer,
  // the one to the page shown too
  const open = (href: string) => (e: MouseEvent) => {
    if (drawer) closeDrawer();
    follow(e, href);
  };
  return (
    <aside class={`rail${drawer ? " rail-drawer" : ""}`}>
      <div class="rail-top">
        <div class="rail-head">
          <a
            class="rail-logo"
            href="/"
            aria-label="Overview"
            onClick={open("/")}
          >
            <Logo height={26} />
            <span class="rail-word">MLX</span>
          </a>
          <button
            ref={hide}
            type="button"
            class="rail-btn rail-hide"
            aria-label={drawer ? "Close the menu" : "Hide the menu"}
            onClick={
              drawer
                ? closeDrawer
                : () => {
                    refocus = true;
                    hideRail();
                  }
            }
          >
            <Icon name={drawer ? "close" : "sidebar"} />
          </button>
        </div>
        <nav class="rail-nav">
          {groups().map((group) => {
            const section = group[0]!.section;
            if (!section) {
              const p = group[0]!;
              return (
                <a
                  key={p.page}
                  href={p.href}
                  class={`rail-item${p.page === page ? " rail-item-on" : ""}`}
                  aria-current={current(p.page === page)}
                  onClick={open(p.href)}
                >
                  <Icon name={ICON[p.page]} />
                  <span>{p.label}</span>
                </a>
              );
            }
            // a section names its pages and is no page itself: lit while
            // one of them is on screen
            const inside = group.some((p) => p.page === page);
            return (
              <Fragment key={section}>
                <div class={`rail-item rail-label${inside ? " rail-in" : ""}`}>
                  <Icon name={SECTION_ICON[section]} />
                  <span>{section}</span>
                </div>
                {group.map((p) => (
                  <a
                    key={p.page}
                    href={p.href}
                    class={`rail-sub${p.page === page ? " rail-sub-on" : ""}`}
                    aria-current={current(p.page === page)}
                    onClick={open(p.href)}
                  >
                    <Icon name={ICON[p.page]} size={14} />
                    <span>{p.label}</span>
                  </a>
                ))}
              </Fragment>
            );
          })}
        </nav>
      </div>
      <User />
    </aside>
  );
}

// the folded rail: the button that brings it back, then the pages as
// icons, a rule between the groups the rail draws
export function Strip({ page }: { page: Page }) {
  const link = (p: Entry) => (
    <a
      key={p.page}
      href={p.href}
      class={`strip-icon${p.page === page ? " strip-icon-on" : ""}`}
      title={p.label}
      aria-label={p.label}
      aria-current={current(p.page === page)}
      onClick={(e) => follow(e, p.href)}
    >
      <Icon name={ICON[p.page]} />
    </a>
  );
  const show = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (refocus) show.current?.focus();
    refocus = false;
  }, []);
  return (
    <aside class="strip">
      <button
        ref={show}
        type="button"
        class="rail-btn"
        aria-label="Show the menu"
        onClick={() => {
          refocus = true;
          showRail();
        }}
      >
        <Icon name="sidebar" />
      </button>
      <nav class="strip-nav">
        {groups().map((group, i) => (
          <Fragment key={group[0]!.page}>
            {i > 0 && <span class="strip-rule" />}
            {group.map(link)}
          </Fragment>
        ))}
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
