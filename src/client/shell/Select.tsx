// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The one select of the page: a button and a listbox drawn here, because a
// native select is the system's own popup and looks like no other control
// on a dark page. Keyboard as a native one: arrows, Home, End, Enter, Space,
// Escape, and a letter jumps to the next option that starts with it.

import { useEffect, useRef, useState } from "preact/hooks";

interface Props<T extends string> {
  name: string;
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled?: boolean;
  class?: string;
  invalid?: boolean;
  describedBy?: string;
}

export function Select<T extends string>(props: Props<T>) {
  const { name, label, value, options, onChange, disabled } = props;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    root.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = () => {
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  };
  const pick = (index: number) => {
    const next = options[index];
    setOpen(false);
    button.current?.focus();
    if (next !== undefined && next !== value) onChange(next);
  };

  const onKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") e.preventDefault();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(last, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key.length === 1) {
      const letter = e.key.toLowerCase();
      const from = active + 1;
      const hit = [...options.slice(from), ...options.slice(0, from)].find(
        (o) => o.toLowerCase().startsWith(letter),
      );
      if (hit !== undefined) setActive(options.indexOf(hit));
    }
  };

  const list = `${name}-list`;
  return (
    <span
      ref={root}
      class={`select${open ? " open" : ""}${props.class ? ` ${props.class}` : ""}`}
    >
      <button
        ref={button}
        type="button"
        role="combobox"
        name={name}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={list}
        aria-activedescendant={open ? `${list}-${active}` : undefined}
        aria-invalid={props.invalid ? "true" : undefined}
        aria-describedby={props.describedBy}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span class="picked">{value}</span>
        <span class="caret" />
      </button>
      {open && (
        <div class="list" id={list} role="listbox" aria-label={label}>
          {options.map((option, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are the combobox's, which keeps the focus
            <div
              key={option}
              id={`${list}-${index}`}
              data-index={index}
              role="option"
              tabIndex={-1}
              aria-selected={option === value}
              class={index === active ? "active" : undefined}
              onPointerEnter={() => setActive(index)}
              // before the button's blur, so the list is still there to hit
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(index)}
            >
              {option}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
