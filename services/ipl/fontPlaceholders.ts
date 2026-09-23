// Date/time placeholder expansions for d4/d5 sources. The viewer renderer
// paints an un-substituted date/time field as "[<format>]" (PRM p.175 — the
// printer fills real values at print time); the IPL→ZPL crosscheck converter
// (tools/ipl2zpl.mjs) keeps its own copy because .mjs tools can't import TS —
// tests/ipl2zpl.test.ts pins the two together so they can't drift.

export const DATE_FORMATS = ['YY/MM/DD', 'YYYY/MM/DD', 'DD/MM/YY', 'DD/MM/YYYY'];
export const TIME_FORMATS = ['HH:MM:SS 24hr', 'HH:MM 24hr', 'HH:MM:SS 12hr', 'HH:MM 12hr', 'HH:MM:SS am/pm', 'HH:MM am/pm'];
