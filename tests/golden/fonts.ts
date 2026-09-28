// Golden-test font portability (audit batch 6): the outline-font CSS stacks in
// constants.ts name "Liberation Mono/Sans/Serif" first. Those TTFs are vendored
// under public/fonts; this module registers them into @napi-rs/canvas'
// GlobalFonts so node golden renders resolve them regardless of host OS fonts
// ("Courier New", Arial, Times New Roman are absent on Linux CI — without this,
// golden PNGs made on Windows diff against a Linux re-render purely from font
// substitution). Liberation is BSD/SIL-licensed and metric-compatible with
// those originals; index.html declares matching @font-face rules for the
// browser, so designer preview and viewer use the same faces too.

import { GlobalFonts } from '@napi-rs/canvas';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const FONTS_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../public/fonts',
);

let registered = false;

/** Register the vendored TTFs once per process; throws if a file is missing
 * (fail loud — silently falling back to ambient fonts is the bug this fixes). */
export const registerBundledFonts = (): void => {
    if (registered) return;
    const files = [
        'LiberationMono-Regular.ttf',
        'LiberationMono-Bold.ttf',
        'LiberationSans-Regular.ttf',
        'LiberationSans-Bold.ttf',
        'LiberationSerif-Regular.ttf',
        'LiberationSerif-Bold.ttf',
        // Century Schoolbook's metric-exact free substitute, for IPL id c67
        // (GUST Font License — the grant is in the file's own name table).
        // CFF outlines, hence .otf.
        'TeXGyreSchola-Regular.otf',
        // Letter Gothic's substitute for IPL id c69 (SIL Open Font License).
        // Chosen because its own advance IS 500/1000 em, matching the printer's
        // 12-pitch face exactly — see services/ipl/fontMetrics.ts.
        'Inconsolata-Regular.ttf',
    ];
    for (const f of files) {
        const p = path.join(FONTS_DIR, f);
        if (!existsSync(p)) {
            throw new Error(`Bundled golden font missing: ${p} (font portability is broken — do not regenerate goldens against ambient OS fonts)`);
        }
        GlobalFonts.registerFromPath(p);
    }
    registered = true;
};
