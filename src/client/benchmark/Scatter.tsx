// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The scorecard's scatter, drawn as SVG: a handful of dots needs no chart
// library, and a dot of its own is what the hover wants. The width follows
// the card; the text stays its size because nothing is stretched. The
// legend under it names every dot with its two figures as text, which is
// what a keyboard or a screen reader gets, and a pointer or a touch on
// either side lights the other: two models can share a spot.

import { useSignal } from "@preact/signals";
import { useLayoutEffect, useRef } from "preact/hooks";
import { modelName, value } from "./report.ts";
import { type Dot, HEIGHT, PAD, plane, tipPlace } from "./scatter.ts";

// how near the pointer a dot counts as under it, in pixels
const REACH = 12;

const color = (slot: number) => `var(--series-${slot})`;
// seconds on both sides of the plane, so 2.4 and 35.6 read as one scale
const wait = (s: number) => `${s.toFixed(1)} s`;
const rate = (tps: number) => value({ median: tps, spreadPct: null }, "tok/s");
const figures = (d: Dot) => `${wait(d.wait)} · ${rate(d.decode)} tok/s`;

export function Scatter({ dots }: { dots: Dot[] }) {
  const box = useRef<HTMLDivElement>(null);
  const tipEl = useRef<HTMLDivElement>(null);
  const width = useSignal(0);
  // the runs under the pointer, from the plane or the legend
  const lit = useSignal<number[]>([]);

  useLayoutEffect(() => {
    const el = box.current!;
    const read = () => {
      width.value = el.clientWidth;
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const p = plane(dots, width.value);
  const shown = dots.filter((d) => lit.value.includes(d.id));
  const tip = shown[0];

  // The tip is placed once it is laid out and its size is known, before
  // the paint (see tipPlace).
  useLayoutEffect(() => {
    const el = tipEl.current;
    if (!el || !tip) return;
    const at = tipPlace(
      { x: p.x(tip.wait), y: p.y(tip.decode) },
      { w: el.offsetWidth, h: el.offsetHeight },
      { w: width.value, h: HEIGHT },
    );
    el.style.left = `${at.left}px`;
    el.style.top = `${at.top}px`;
  });

  const hover = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    lit.value = dots
      .filter((d) => Math.hypot(p.x(d.wait) - px, p.y(d.decode) - py) <= REACH)
      .map((d) => d.id);
  };
  const clear = () => {
    lit.value = [];
  };

  return (
    <section class="card scatter">
      <div class="plane" ref={box}>
        {width.value > 0 && (
          <svg
            width={width.value}
            height={HEIGHT}
            role="img"
            aria-label="Decode rate against the wait on a warm turn, one dot per model"
            onPointerMove={hover}
            onPointerDown={hover}
            onPointerLeave={clear}
          >
            {p.xs.map((t) => (
              <g key={`x${t}`}>
                <line
                  class="grid"
                  x1={p.x(t)}
                  x2={p.x(t)}
                  y1={PAD.top}
                  y2={PAD.top + p.h}
                />
                <text
                  class="tick"
                  x={p.x(t)}
                  y={HEIGHT - 10}
                  text-anchor="middle"
                >
                  {/* the corner is the y axis' 0 already */}
                  {t === 0 ? "" : `${t} s`}
                </text>
              </g>
            ))}
            {p.ys.map((t) => (
              <g key={`y${t}`}>
                <line
                  class="grid"
                  x1={PAD.left}
                  x2={PAD.left + p.w}
                  y1={p.y(t)}
                  y2={p.y(t)}
                />
                <text
                  class="tick"
                  x={PAD.left - 8}
                  y={p.y(t) + 4}
                  text-anchor="end"
                >
                  {t}
                </text>
              </g>
            ))}
            <text class="corner" x={PAD.left + 8} y={PAD.top + 14}>
              ↖ faster
            </text>
            {dots.map((d) => (
              <circle
                key={d.id}
                class={lit.value.includes(d.id) ? "dot lit" : "dot"}
                cx={p.x(d.wait)}
                cy={p.y(d.decode)}
                r={lit.value.includes(d.id) ? 8 : 6}
                style={{ fill: color(d.slot) }}
              />
            ))}
          </svg>
        )}
        {tip && (
          <div class="tip" ref={tipEl}>
            {shown.map((d) => (
              <div key={d.id}>
                <i style={{ background: color(d.slot) }} />
                <span class="model">{modelName(d.model)}</span>
                <span class="v">{figures(d)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div class="axes">
        <span>up: decode, tok/s</span>
        <span>across: wait on a warm turn</span>
      </div>
      <ul class="keys">
        {dots.map((d) => (
          <li
            key={d.id}
            class={lit.value.includes(d.id) ? "lit" : undefined}
            onPointerEnter={() => {
              lit.value = [d.id];
            }}
            onPointerLeave={clear}
          >
            <i style={{ background: color(d.slot) }} />
            <span class="model">{modelName(d.model)}</span>
            <span class="v">{wait(d.wait)}</span>
            <span class="v">{rate(d.decode)}</span>
            <small>tok/s</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
