// Date/time rendering for the designer's date and time data sources.
//
// SINGLE SOURCE. This used to exist twice, identical, in geometry.ts (layout
// measurement) and canvasDrawer.ts (painting). Two copies of a formatter that
// must agree with the printed output is a WYSIWYG bug waiting to happen — and
// iplGenerator now needs it a third time, to bake a real date into the stream.
//
// Why baking: IPL has no clock. `dn` documents only n=0..3 (PRM p.184 "Field
// Data, Define Source"), so `d4`/`d5` are not commands any printer understands
// — the previous generator emitted them anyway and the viewer answered with a
// plausible-looking [YY/MM/DD] placeholder, which is exactly the silent-wrong
// output this project exists to avoid. The designer keeps its live preview; at
// generate time the current value is written as `d3` fixed text, which every
// printer prints correctly. Deterministic, honest, and it needs no firmware
// support we cannot verify.

import type { DateFormat, TimeFormat } from '../types';

/**
 * Format `now` per the field's chosen format. The print is a snapshot of the
 * moment the file is generated — re-generating tomorrow yields tomorrow's
 * date, which is the honest behaviour for a language with no clock.
 */
export function getFormattedDateTime(type: 'date' | 'time', format: string, now: Date = new Date()): string {
    const YYYY = now.getFullYear();
    const YY = YYYY.toString().slice(-2);
    const MM = (now.getMonth() + 1).toString().padStart(2, '0');
    const DD = now.getDate().toString().padStart(2, '0');
    let HH = now.getHours();
    const M = now.getMinutes().toString().padStart(2, '0');
    const SS = now.getSeconds().toString().padStart(2, '0');

    if (type === 'date') {
        switch (format as DateFormat) {
            case 'YYYY/MM/DD': return `${YYYY}/${MM}/${DD}`;
            case 'DD/MM/YY': return `${DD}/${MM}/${YY}`;
            case 'DD/MM/YYYY': return `${DD}/${MM}/${YYYY}`;
            case 'YY/MM/DD':
            default:
                return `${YY}/${MM}/${DD}`;
        }
    }

    const is12hr = format.includes('12hr') || format.includes('am/pm');
    const ampm = HH >= 12 ? 'pm' : 'am';
    if (is12hr) {
        HH = HH % 12;
        HH = HH ? HH : 12; // the hour '0' should be '12'
    }
    const HH_str = HH.toString().padStart(2, '0');

    switch (format as TimeFormat) {
        case 'HH:MM 24hr': return `${HH_str}:${M}`;
        case 'HH:MM:SS 12hr': return `${HH_str}:${M}:${SS}`;
        case 'HH:MM 12hr': return `${HH_str}:${M}`;
        case 'HH:MM:SS am/pm': return `${HH_str}:${M}:${SS} ${ampm}`;
        case 'HH:MM am/pm': return `${HH_str}:${M} ${ampm}`;
        case 'HH:MM:SS 24hr':
        default:
            return `${HH_str}:${M}:${SS}`;
    }
}
