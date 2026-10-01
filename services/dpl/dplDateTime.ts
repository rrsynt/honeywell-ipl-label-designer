// The `<STX>T` time and date markers, from the Datamax *Class Series
// Programmer's Manual* (88-2316-01 Rev H, p. 126, Table 6-3), cross-checked
// against the Class Series 2 manual (88-2341-01), which carries the same table.
//
// `<STX>T` is one of DPL's two "Special Label Formatting Commands": it is
// written INTO the data field of a record and asks the printer's internal clock
// for the value. The manual is explicit that the string forms are not printed —
// "the printed label will show a corresponding print value" — and that the
// command "may be preceded by data to be printed/encoded", so the record's own
// text and a substitution share one data field.
//
// THE MODEL, which is what makes this table its own thing rather than a copy of
// another language's: every marker letter is a POSITIONAL PLACEHOLDER, and the
// letter's index inside its group picks which character of the value is printed.
// Nothing in the manual states that outright, but the table is unreadable any
// other way, and the manual's own samples prove it:
//
//   `BCD GHI PQ, TU`  ->  "SUN DEC 21, 98"   (sample 1, p. 126)
//   `EF/PQ`           ->  "12/21"            (sample 2)
//
//   B,C,D  are the three characters of the weekday name, so G,H,I — the FIRST
//          THREE of the nine-letter month-name group G..O — are the first three
//          characters of "DECEMBER", i.e. "DEC"; and T,U are the last two digits
//          of the four-digit year R,S,T,U, i.e. "98".
//
// Checking every group the same way (each value's width equals its letter count,
// and the 34 letters A-Z plus a-h are used exactly once with no gaps) is what
// confirms the reading. A table that had drifted — as this project's other
// languages have each been burned by — would fail one of those two counts.
//
// Every character that is NOT one of those letters is printed as itself: the
// spaces and comma in sample 1 survive into the output, so the string is a
// TEMPLATE mixing literals with placeholders, not a list of markers.

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const MONTHS = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

/**
 * Formats an `AM`/`PM` pair. The marker letters are `b` and `c`, so index 0
 * is the `A`/`P` and index 1 the `M`.
 */
const ampm = (d: Date): string => (d.getHours() >= 12 ? 'PM' : 'AM');

/** Day of the year, 1-366, zero-padded to the three digits of `d`, `e`, `f`. */
const julianDay = (d: Date): string => {
    const start = Date.UTC(d.getFullYear(), 0, 0);
    const here = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return String(Math.floor((here - start) / 86400000)).padStart(3, '0');
};

interface MarkerGroup {
    /** The marker letters, in output order. `letters[i]` prints `value()[i]`. */
    letters: string;
    value: (d: Date) => string;
}

/**
 * Table 6-3, left half then right half. Order carries no meaning beyond the
 * reading above — the letters within a group are what address the characters.
 */
const GROUPS: MarkerGroup[] = [
    { letters: 'A', value: d => String(((d.getDay() + 6) % 7) + 1) },
    { letters: 'BCD', value: d => WEEKDAYS[(d.getDay() + 6) % 7] },
    { letters: 'EF', value: d => String(d.getMonth() + 1).padStart(2, '0') },
    { letters: 'GHIJKLMNO', value: d => MONTHS[d.getMonth()].padEnd(9, ' ') },
    { letters: 'PQ', value: d => String(d.getDate()).padStart(2, '0') },
    { letters: 'RSTU', value: d => String(d.getFullYear()).padStart(4, '0') },
    { letters: 'VW', value: d => String(d.getHours()).padStart(2, '0') },
    { letters: 'XY', value: d => String(d.getHours() % 12 || 12).padStart(2, '0') },
    { letters: 'Za', value: d => String(d.getMinutes()).padStart(2, '0') },
    { letters: 'bc', value: ampm },
    { letters: 'def', value: julianDay },
    { letters: 'gh', value: d => String(d.getSeconds()).padStart(2, '0') },
];

const LOOKUP: Record<string, MarkerGroup> = Object.fromEntries(
    GROUPS.flatMap(g => [...g.letters].map(l => [l, g])),
);

/** True when `ch` is one of the 34 documented markers (A-Z, a-h). */
export const isDplDateMarker = (ch: string): boolean => ch in LOOKUP;

/**
 * Replaces every marker in `template` with the matching character of the
 * current value, leaving every other character alone.
 *
 * `now` is passed in rather than read here so the substitution is a snapshot
 * the caller controls — the same reason dateTimeFormat.getFormattedDateTime
 * takes it.
 */
export const substituteDplDateTime = (template: string, now: Date = new Date()): string => {
    let out = '';
    for (const ch of template) {
        const group = LOOKUP[ch];
        if (!group) { out += ch; continue; }
        const value = group.value(now);
        const idx = group.letters.indexOf(ch);
        // A value shorter than its letter group would leave a hole; the values
        // above are all padded to the group's width, so this is a guard against
        // a future edit rather than an expected path.
        out += value[idx] ?? '';
    }
    return out;
};
