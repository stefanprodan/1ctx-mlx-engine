// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one design of a list of figures, as 1ctx has one of a list of
// things: a card, its head band with the search and a few filters, a
// table whose first cell is a name over a faint line and whose others are
// bold figures, and a row that opens to a panel of titled groups. The
// Requests history and the benchmark runs are both made of it; a page
// fills the parts and styles only what is its own.

import type { ComponentChildren } from "preact";
import { Close, Search } from "../icons.tsx";
import "./grid.css";

export type GridFilter = { label: string; on: boolean; onPick: () => void };

export type GridColumn = {
  key: string;
  label: string;
  // shown only while the card is wide enough; the open row has it
  wide?: boolean;
};

export type GridGroup = {
  title: string;
  rows: { label: string; value: string; unit?: string; spread?: string }[];
};

export function GridCard({ children }: { children: ComponentChildren }) {
  return <section class="card grid-card">{children}</section>;
}

// the card's head band, as 1ctx draws a list's search: no box of its
// own, the glass where a row's chevron is and lit while it has the
// focus, the text where the name is, the filters at the end. Shown while
// a search hides every row, so the way back stays
export function GridFind({
  name,
  placeholder,
  query,
  onQuery,
  filtersLabel,
  filters,
  hidden,
}: {
  name: string;
  placeholder: string;
  query: string;
  onQuery: (q: string) => void;
  filtersLabel: string;
  filters: GridFilter[];
  hidden?: boolean;
}) {
  return (
    <div class="grid-find" hidden={hidden}>
      <label class="grid-q">
        <Search />
        <input
          type="search"
          name={name}
          placeholder={placeholder}
          aria-label={placeholder}
          autocomplete="off"
          spellcheck={false}
          value={query}
          onInput={(e) => onQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onQuery("");
          }}
        />
        {/* ours, not the native one, which shows only with the focus */}
        <button
          type="button"
          class="grid-clear"
          aria-label="Clear search"
          hidden={query.trim() === ""}
          onClick={() => onQuery("")}
        >
          <Close />
        </button>
      </label>
      <nav class="grid-filters" aria-label={filtersLabel}>
        {filters.map((f) => (
          <button
            type="button"
            key={f.label}
            class={f.on ? "on" : undefined}
            aria-pressed={f.on}
            onClick={f.onPick}
          >
            {f.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

// the table and its head; `end` keeps a narrow last column for a control
export function GridTable({
  id,
  name,
  columns,
  end,
  hidden,
  children,
}: {
  id: string;
  name: string;
  columns: GridColumn[];
  end?: boolean;
  hidden?: boolean;
  children: ComponentChildren;
}) {
  return (
    <table id={id} class="grid" hidden={hidden}>
      <thead>
        <tr>
          <th class="grid-name">{name}</th>
          {columns.map((c) => (
            <th class={`fig ${c.key}${c.wide ? " grid-wide" : ""}`} key={c.key}>
              {c.label}
            </th>
          ))}
          {end && <th class="grid-end" />}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// a row: the chevron, the name over one faint line, the figures, and the
// end's control outside the toggle
export function GridRow({
  open,
  onToggle,
  name,
  title,
  meta,
  columns,
  figures,
  flagged,
  end,
}: {
  open: boolean;
  onToggle: () => void;
  name: string;
  // the whole name, under the pointer
  title?: string;
  meta: ComponentChildren;
  columns: GridColumn[];
  // by column key: the figure, and a faint line under it
  figures: Record<string, { value: string; under?: ComponentChildren }>;
  flagged?: boolean;
  end?: ComponentChildren;
}) {
  const cls = [open ? "open" : "", flagged ? "flagged" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <tr class={cls || undefined} onClick={onToggle}>
      <td class="grid-name">
        {/* the grid lives inside: a cell that is a grid drops out of the row */}
        <div class="grid-cell">
          <span class="chev" />
          <span class="name" title={title}>
            {name}
          </span>
          <span class="meta">{meta}</span>
        </div>
      </td>
      {columns.map((c) => {
        const f = figures[c.key];
        return (
          <td
            class={`num fig ${c.key}${c.wide ? " grid-wide" : ""}`}
            key={c.key}
          >
            {f?.value}
            {f?.under}
          </td>
        );
      })}
      {end !== undefined && <td class="grid-end">{end}</td>}
    </tr>
  );
}

// the opened row: the whole name on top, what went wrong, the groups of
// label and value lines, then whatever the page adds and its buttons
export function GridDetail({
  span,
  name,
  tag,
  why,
  groups,
  children,
  foot,
}: {
  span: number;
  name: string;
  tag?: string | null;
  why?: string | null;
  groups: GridGroup[];
  // under the groups, inside the panel
  children?: ComponentChildren;
  // under the panel: a table of its own, then the buttons
  foot?: ComponentChildren;
}) {
  return (
    <tr class="detail">
      <td colSpan={span}>
        <div class="dpanel">
          <div class="dhead">
            <span class="dmodel">{name}</span>
            {tag && <span class="dquant">{tag}</span>}
          </div>
          {why && <p class="dwhy">{why}</p>}
          <div class="dgroups">
            {groups.map((group) => (
              <section class="dgroup" key={group.title}>
                <h3>{group.title}</h3>
                <dl>
                  {group.rows.map((row) => (
                    <div class="drow" key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>
                        {row.value}
                        {row.unit && <span class="dim"> {row.unit}</span>}
                        {row.spread && <span class="dim"> {row.spread}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
          {children}
        </div>
        {foot}
      </td>
    </tr>
  );
}

// the faint line in the card: no rows yet, or none the search leaves
export function GridNote({
  hidden,
  children,
}: {
  hidden?: boolean;
  children: ComponentChildren;
}) {
  return (
    <p class="blank" hidden={hidden}>
      {children}
    </p>
  );
}
