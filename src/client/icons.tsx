// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The inline SVGs as components, so a page can drop one in without
// carrying the path data around.

// the clear buttons in the section heads
export const Trash = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M4 7h16M10 11v6M14 11v6M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"
    />
  </svg>
);

// the Download button in the Models head
export const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"
    />
  </svg>
);

// beside a command the reader runs elsewhere
export const Copy = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
    />
  </svg>
);

// the locality line on the Server page
export const Lock = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.75"
      d="M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2M7 11V7a5 5 0 0 1 10 0v4"
    />
  </svg>
);

// the search row of the runs table
export const Search = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="2"
      d="M11 18a7 7 0 1 0 0-14a7 7 0 0 0 0 14m9 2l-4-4"
    />
  </svg>
);

// clears the runs search, whether or not it has the focus
export const Close = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-width="2"
      d="M6 6l12 12M18 6L6 18"
    />
  </svg>
);

const SPARKLE =
  "M19.5 1.0C19.5 2.925 21.075 4.5 23.0 4.5C21.075 4.5 19.5 6.075 19.5 8.0C19.5 6.075 17.925 4.5 16.0 4.5C17.925 4.5 19.5 2.925 19.5 1.0Z";

// 1ctx's logo, the wordmark inside the wide chip (170.19 by 90), in one
// colour, sparkle included, as the engine's mark always was
export function Logo({ height = 26 }: { height?: number }) {
  const width = Math.round((height * 170.19) / 90);
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 170.19 90"
      aria-hidden="true"
    >
      <g
        transform="translate(3 15)"
        fill="none"
        stroke-width="6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          stroke="currentColor"
          d="M126.19 0H18.72A18.72 18.72 0 0 0 0 18.72V53.28A18.72 18.72 0 0 0 18.72 72H133.47A18.72 18.72 0 0 0 152.19 53.28V26"
        />
        <path
          fill="currentColor"
          stroke="none"
          transform="translate(74.19 -18) scale(4)"
          d={SPARKLE}
        />
      </g>
      <path
        fill="currentColor"
        transform="translate(23 68.5)"
        d="M4.03 0V-5.42H13.14V-29.2L3.98 -22.49V-29.2L12.03 -35H19.13V-5.42H26.47V0Z M42.62 0.48Q39.22 0.48 36.7 -0.79Q34.18 -2.06 32.79 -4.39Q31.4 -6.71 31.4 -9.88V-16.49Q31.4 -19.66 32.79 -21.98Q34.18 -24.31 36.7 -25.58Q39.22 -26.85 42.62 -26.85Q47.56 -26.85 50.56 -24.28Q53.55 -21.72 53.7 -17.31H47.8Q47.66 -19.37 46.24 -20.5Q44.83 -21.62 42.62 -21.62Q40.18 -21.62 38.79 -20.3Q37.4 -18.99 37.4 -16.54V-9.88Q37.4 -7.43 38.79 -6.09Q40.18 -4.75 42.62 -4.75Q44.88 -4.75 46.27 -5.87Q47.66 -7 47.8 -9.06H53.7Q53.55 -4.65 50.56 -2.09Q47.56 0.48 42.62 0.48Z M72.64 0Q68.95 0 66.76 -2.13Q64.58 -4.27 64.58 -7.91V-20.95H57.29V-26.37H64.58V-33.8H70.62V-26.37H81.12V-20.95H70.62V-8.05Q70.62 -6.9 71.27 -6.16Q71.92 -5.42 73.07 -5.42H80.88V0Z M85.15 0 94.36 -13.62 85.77 -26.37H92.53L96.61 -19.9Q96.99 -19.32 97.33 -18.6Q97.66 -17.88 97.81 -17.45Q98 -17.88 98.31 -18.6Q98.62 -19.32 99.01 -19.9L103.08 -26.37H109.89L101.31 -13.62L110.47 0H103.66L99.1 -7.24Q98.72 -7.82 98.36 -8.56Q98 -9.3 97.81 -9.73Q97.62 -9.3 97.28 -8.56Q96.95 -7.82 96.56 -7.24L91.96 0Z"
      />
    </svg>
  );
}

// the rail's icons, 1ctx's 16 box and 1.5 stroke; sidebar, close,
// chevron and redo are 1ctx's own paths
const PATHS = {
  sidebar:
    "M3.5 3h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 3v10",
  close: "M4 4l8 8M12 4l-8 8",
  chevron: "M5 6.5l3 3 3-3",
  redo: "M14 8a6 6 0 1 1-1.8-4.3M14 2v3.5h-3.5",
  pulse: "M1.5 8h3l2-5 3 10 2-5h3",
  grid: "M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z",
  swap: "M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13",
  chip: "M5 3h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM6.5 6.5h3v3h-3zM6.5 1v2M9.5 1v2M6.5 13v2M9.5 13v2M1 6.5h2M1 9.5h2M13 6.5h2M13 9.5h2",
  gauge: "M4.1 12.9A5.5 5.5 0 1 1 11.9 12.9M8 9l2.5-2.5",
  cube: "M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM2.5 4.5L8 7.5l5.5-3M8 7.5v7",
  server:
    "M3.5 2.5h9a1 1 0 0 1 1 1v3h-11v-3a1 1 0 0 1 1-1zM2.5 9.5h11v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1zM2.5 6.5v3M13.5 6.5v3M5 5h.01M5 11.5h.01",
  play: "M4.5 3.5v9L12 8z",
  bars: "M3 13.5V9M8 13.5V3M13 13.5V6.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  class: cls,
}: {
  name: IconName;
  size?: number;
  class?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

// GitHub's mark, filled, for the link to the source
export const GitHub = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
    />
  </svg>
);
