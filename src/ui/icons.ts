// Inline SVG icons (24x24, drawn with currentColor) for weapons, unit tags, slots, wheel classes and HUD glyphs.
// Kept as path data so they scale crisply from 1280x720 to 4K and need no image requests.

const P: Record<string, string> = {
  // weapons
  sword: '<path d="M19 3l-9.5 9.5M19 3h2v2l-9.5 9.5M8 13l3 3M6.5 14.5l3 3M5 19l2.5-2.5M3.5 20.5l2-2" />',
  axe: '<path d="M14 4l6 6M9 9l11 11" /><path d="M6 3c-2 3-2 7 1 10l5-5C9 5 8 3 6 3z" fill="currentColor" fill-opacity=".35" />',
  lance: '<path d="M4 20L17 7M17 7l3-4-4 3M13 7l4 4M7 15l2 2" />',
  bow: '<path d="M6 3c8 2 13 7 15 15" /><path d="M6 3l15 15M3 9l7-1-1 7" />',
  tome: '<path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z" /><path d="M5 17a3 3 0 013-3h11M10 8h5" />',
  staff: '<path d="M7 21L16 8" /><circle cx="17.5" cy="6" r="3" /><path d="M14 3l1 1M21 9l-1-.5" />',
  bolt: '<path d="M3 21l15-15M18 6l3-3M15 3l3 3-3 3M11 13l-3-1M14 10l-3-1" />',
  stone: '<circle cx="12" cy="13" r="6" fill="currentColor" fill-opacity=".35" /><path d="M8 12l3-2 3 2M10 16l2-1" />',
  fists: '<path d="M6 10V7a1.5 1.5 0 013 0v3M9 9V6a1.5 1.5 0 013 0v4M12 9V7a1.5 1.5 0 013 0v4M15 10V9a1.5 1.5 0 013 0v4c0 4-3 7-6 7s-6-2-6-6v-4" />',
  beam: '<circle cx="9" cy="12" r="6" /><path d="M6 9a4 4 0 000 6" /><path d="M15 12h7M14.5 8.5l6-3M14.5 15.5l6 3" />',
  breath: '<path d="M3 12c3-4 6-4 8-2M3 12c3 4 6 4 8 2" /><path d="M11 12c2-3 5-5 10-6-2 2-3 4-3 6s1 4 3 6c-5-1-8-3-10-6z" fill="currentColor" fill-opacity=".35" />',
  // tags
  mounted: '<path d="M4 20l2-6c-1-3 1-6 4-7l3-3 1 3c3 1 5 4 5 7v6M10 14h6M8 20v-4M16 20v-4" />',
  armored: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" /><path d="M12 7v10M8 10h8" />',
  flier: '<path d="M2 12c4-1 7-4 10-8 0 4 1 6 3 7 2-1 5-1 7 1-3 0-5 1-6 3-1 3-3 5-6 6 0-3-1-5-3-6-2 0-4-1-5-3z" />',
  large: '<path d="M4 20V9l4-5 4 5 4-5 4 5v11z" /><path d="M9 20v-5h6v5" />',
  infantry: '<circle cx="12" cy="6" r="2.5" /><path d="M7 21l2-7-2-3 5-1 5 1-2 3 2 7M12 10v5" />',
  // slots
  weapon: '<path d="M19 3l-9.5 9.5M19 3h2v2l-9.5 9.5M8 13l3 3M5 19l3.5-3.5" />',
  armor: '<path d="M7 3l5 2 5-2 4 4-3 3v11H6V10L3 7z" /><path d="M12 5v16" />',
  relic: '<circle cx="12" cy="14" r="6" /><path d="M9 3h6l-3 5zM12 11l1 2h2l-1.6 1.3.6 2.2-2-1.3-2 1.3.6-2.2L9 13h2z" />',
  // HUD
  gold: '<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".25" /><circle cx="12" cy="12" r="8" /><path d="M12 7v10M9.5 9.5c0-1.2 1-2 2.5-2s2.5.8 2.5 2-1 1.6-2.5 2-2.5.8-2.5 2 1 2 2.5 2 2.5-.8 2.5-2" />',
  keep: '<path d="M4 21V8h3V5h3v3h4V5h3v3h3v13z" /><path d="M10 21v-5a2 2 0 014 0v5M4 8h16" />',
  timer: '<circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M10 2h4" />',
  deploy: '<path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v3h16v-3" />',
  squads: '<path d="M5 20l3-14 3 14M13 20l3-14 3 14M3 13h18" />',
  ready: '<path d="M5 12l5 5L20 7" />',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />',
  chat: '<path d="M4 5h16v11H9l-5 4z" />',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11" />',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6" />',
  gear: '<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />',
  camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3z" /><circle cx="12" cy="13" r="4" />',
  skip: '<path d="M5 5l8 7-8 7zM13 5l8 7-8 7z" fill="currentColor" fill-opacity=".3" />',
  speed: '<path d="M4 18a9 9 0 1116 0" /><path d="M12 14l4-6" />',
  crown: '<path d="M3 18l2-11 5 5 2-7 2 7 5-5 2 11z" /><path d="M3 21h18" />',
  skull: '<path d="M5 11a7 7 0 1114 0v3l-2 2v4H7v-4l-2-2z" /><circle cx="9" cy="12" r="1.5" fill="currentColor" /><circle cx="15" cy="12" r="1.5" fill="currentColor" />',
  star: '<path d="M12 3l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 16.6 6.4 20l1.5-6.3L3 9.5 9.4 9z" />',
  flame: '<path d="M12 3c1 4 6 6 6 11a6 6 0 01-12 0c0-3 2-4 2-7 2 1 3 3 3 5 1-1 2-5 1-9z" />',
  lightning: '<path d="M13 2L5 13h6l-1 9 8-12h-6z" />',
  heart: '<path d="M12 20s-8-5-8-11a4 4 0 018-1 4 4 0 018 1c0 6-8 11-8 11z" />',
  shield: '<path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z" />',
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />',
  rotate: '<path d="M20 12a8 8 0 11-3-6.2M20 4v5h-5" />',
  up: '<path d="M12 19V5M5 12l7-7 7 7" />',
  sell: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />',
  close: '<path d="M6 6l12 12M18 6L6 18" />',
  link: '<path d="M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1" />',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3" />',
  ai: '<rect x="5" y="7" width="14" height="12" rx="2" /><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6" />',
  sword2: '<path d="M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 17.5L21 6V3h-3L6.5 14.5M11 19l-6-6M8 16l-4 4M5 21l-2-2" />',
  bag: '<path d="M6 8h12l1 13H5z" /><path d="M9 8V6a3 3 0 016 0v2" />',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" />',
  flag: '<path d="M5 21V4" /><path d="M5 4h12l-2.5 4L17 12H5z" fill="currentColor" fill-opacity=".3" />',
  help: '<circle cx="12" cy="12" r="9" /><path d="M9.2 9.3a2.9 2.9 0 015.6 1c0 2-2.8 2.4-2.8 4.2M12 17.6v.2" />',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />',
  undo: '<path d="M9 7L4 12l5 5" /><path d="M4 12h10a6 6 0 010 12" transform="translate(0 -3.5)" />',
  chart: '<path d="M4 20V4M4 20h16M8 16v-5M12 16V7M16 16v-8" />',
  spectate: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />',
  grid: '<path d="M4 4h16v16H4zM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16" />',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2.4" /><path d="M9 7l-6 5 6 5zM15 7l6 5-6 5z" fill="currentColor" fill-opacity=".3" />',
  route: '<circle cx="6" cy="19" r="2" /><path d="M7.6 17.6c4-3.6-1.6-6.6 3-10.2 2.4-1.9 5.4-2.4 8.4-3.4" stroke-dasharray="2.4 2.2" /><path d="M16 3l3.4 1-1.2 3.2" />',
  sync: '<path d="M20 3v18" /><path d="M3 7h12M7 12h8M10 17h5" /><path d="M13 5l2 2-2 2M13 10l2 2-2 2M13 15l2 2-2 2" />',
  // the counter wheel's eight classes (cls_<WheelClass>): flat carved stamps, one idea each
  cls_swarm: '<circle cx="6" cy="8.5" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="18" cy="8.5" r="2" /><path d="M2.5 20v-4.5a3.5 3.5 0 017 0M8.5 20v-7a3.5 3.5 0 017 0v7M14.5 15.5a3.5 3.5 0 017 0V20" />',
  cls_giant: '<path d="M10 3h4v3h-4z" /><path d="M6 21v-5H4V9.5L7 6.5h10l3 3V16h-2v5M9 21v-4h6v4M9 10v3M15 10v3" />',
  cls_line: '<path d="M4 4h11v8.5c0 4.2-2.8 6.8-5.5 8C6.8 19.3 4 16.7 4 12.5z" /><path d="M9.5 4v16M4 10h11" /><path d="M19.5 2v20M18 5l1.5-3 1.5 3" />',
  cls_cavalry: '<path d="M18 21c0-6-1-10.5-4-14.5L13.2 3l-1.7 2.6C8 7 5.4 9 4 11.2l1.6 2.3 4-1.1c.6 3-1 5.8-1.6 8.6" /><path d="M14 6.5c2 .5 4 2 5 4" /><circle cx="10.5" cy="8.6" r=".9" fill="currentColor" />',
  cls_ranged: '<path d="M12 21V4" /><path d="M8 8l4-5 4 5" /><path d="M9 21l3-3 3 3M9 17.5l3-3 3 3" />',
  cls_air: '<path d="M12 12C10 7.5 6.5 5.5 2 5.5c.8 4.2 3.6 7.2 8 8.3M12 12c2-4.5 5.5-6.5 10-6.5-.8 4.2-3.6 7.2-8 8.3" /><path d="M12 9.5V20M9.5 18l2.5 2 2.5-2M6 9l2 1.5M18 9l-2 1.5" />',
  cls_siege: '<path d="M3 21h18M6.5 21l5.5-9.5 5.5 9.5" /><path d="M4.5 6.5L19 14.5" /><circle cx="4.5" cy="4.5" r="2" fill="currentColor" fill-opacity=".35" /><path d="M17 13.4l2.5-3" />',
  cls_magic: '<path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6M5.6 5.6l3.2 3.2M15.2 15.2l3.2 3.2M18.4 5.6l-3.2 3.2M8.8 15.2l-3.2 3.2" /><circle cx="12" cy="12" r="2.2" fill="currentColor" fill-opacity=".35" />',
};

export type IconName = keyof typeof P | string;

/** `<svg>` markup for an icon (unknown names render an empty frame). */
export function icon(name: IconName, cls = ''): string {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
}
