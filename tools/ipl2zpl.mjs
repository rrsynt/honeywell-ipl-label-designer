// Minimal IPL -> ZPL converter for the Labelary cross-check tool.
// (No shebang: this file is imported by tests/ipl2zpl.test.ts through
// vite-node's vm.Script runner, which rejects a leading `#!` line. It is
// always invoked as `node tools/ipl2zpl.mjs`, so the shebang was decorative.)
//
// Scope: layout-intent conversion (positions, sizes, data, barcode types).
// Fonts are approximated with ZPL scalable font 0 - this is a regression
// testing aid, not a production translator.

import fs from 'node:fs';

const STX = '\x02', ETX = '\x03', ESC = '\x1b', CAN = '\x18', NUL = '\x00';

const normalize = s => s.replace(new RegExp(STX, 'g'), '<STX>').replace(new RegExp(ETX, 'g'), '<ETX>');

function tokenize(code) {
    const src = normalize(code);
    const frames = [];
    let pos = 0;
    while (pos < src.length) {
        const start = src.indexOf('<STX>', pos);
        if (start < 0) break;
        const end = src.indexOf('<ETX>', start + 5);
        if (end < 0) { frames.push(src.slice(start + 5).trim()); break; }
        const c = src.slice(start + 5, end).trim();
        if (c) frames.push(c);
        pos = end + 5;
    }
    return frames;
}

function printBlockData(code) {
    const m = /(?:<CAN>|\x18)([\s\S]*?)(?:<(?:ETB|RS|FF)>|[\x17\x1e\x0c])/i.exec(normalize(code));
    const map = new Map();
    if (!m) return map;
    const block = m[1].replace(/<ESC>/g, ESC).replace(/<NUL>/g, NUL);
    const re = new RegExp(ESC + 'F(\\d+)' + NUL + '([\\s\\S]*?)(?=' + ESC + 'F\\d+' + NUL + '|$)', 'g');
    let x;
    while ((x = re.exec(block)) !== null) map.set(parseInt(x[1], 10), x[2]);
    return map;
}

const paramsOf = body => body.split(';').filter(p => p).map(p => [p[0], p.slice(1)]);
const intP = (params, key, fb) => {
    const p = params.find(([k]) => k === key);
    if (!p) return fb;
    const n = parseInt(p[1].split(',')[0], 10);
    return isNaN(n) ? fb : n;
};

// Visual top-left for a rotated field whose origin anchor follows IPL rules.
// L/C are the unrotated length/cross dims in dots.
function visualTopLeft(ox, oy, f, L, C) {
    switch (((f % 4) + 4) % 4) {
        case 1: return [ox, oy - L];
        case 2: return [ox - L, oy - C];
        case 3: return [ox - C, oy];
        default: return [ox, oy];
    }
}

const zplEscape = s => String(s).replace(/\\/g, '\\\\').replace(/\^/g, '^^').replace(/~/g, '~^').replace(/\n/g, '\\&');

function textDims(el) {
    if (el.pointSize) {
        const h = Math.max(8, Math.round(el.pointSize / 72 * el.dpi));
        return { L: Math.max(1, el.data.length) * Math.round(h * 0.6), C: h };
    }
    return { L: el.data.length * 8 * el.wMag, C: 9 * el.hMag };
}

export function iplToZpl(iplCode, dpi = 203) {
    const varData = printBlockData(iplCode);
    const out = ['^XA', '^CI28', '^FWN'];
    let qty = 1;
    let inFormat = false;
    let dgMode = false;
    let dgCount = 0;

    // Expand chained frames ("<ESC>P;E1;F1;H1;...;R") into logical frames.
    const CMD = /^(?:[HBLWUG]\d*|E\d+|R)$/;
    const frames = [];
    for (const f of tokenize(iplCode)) {
        if (f.startsWith('<ESC>P') && f.includes(';')) {
            let buf = '';
            const flush = () => { if (buf) { frames.push(buf); buf = ''; } };
            for (const seg of f.slice('<ESC>P'.length).split(';')) {
                const t = seg.trim();
                if (!t) continue;
                if (CMD.test(t)) { flush(); buf = t; } else if (buf) buf += `;${t}`;
            }
            flush();
        } else {
            frames.push(f);
        }
    }

    // d4/d5 are not IPL commands (PRM p.184 defines only d0-d3), so a stream
    // carrying them prints nothing there. The viewer says so with an issue and
    // draws an empty field; this converter mirrors that rather than inventing
    // a [DD/MM/YYYY] placeholder, which used to make both sides agree on text
    // no printer would ever produce.
    const resolveData = (params, id) => {
        const d = params.find(([k]) => k === 'd');
        if (!d) return varData.get(id ?? -1) ?? '';
        if (d[1].startsWith('3,')) return d[1].slice(2);
        if (d[1][0] === '4' || d[1][0] === '5') return '';
        return varData.get(id ?? -1) ?? '';
    };

    // Setup params (<SI>W/L/S/d…) are scanned from the WHOLE stream once:
    // this app's generator and BarTender emit the combined "<ESC>C<SI>W…<SI>h"
    // config frame, and a startsWith('<SI>') gate in the frame loop silently
    // dropped ^PW/^LL — Labelary then rendered at its 812-dot default and the
    // cross-check compared against the wrong paper size.
    {
        const w = iplCode.match(/<SI>W(\d+)/); if (w) out.push(`^PW${w[1]}`);
        const l = iplCode.match(/<SI>L(\d+)/); if (l) out.push(`^LL${l[1]}`);
        const sp = iplCode.match(/<SI>S(\d+)/); if (sp) out.push(`^PR${Math.max(2, Math.round(parseInt(sp[1], 10) / 10))}`);
        const dk = iplCode.match(/<SI>d(-?\d+)/); if (dk) out.push(`~SD${Math.max(0, Math.min(30, parseInt(dk[1], 10) + 20))}`);
    }

    for (const frame of frames) {
        if (frame.startsWith('<SI>')) continue; // pure setup frame — consumed above
        if (frame === 'R') { inFormat = false; continue; }
        if (frame.startsWith('<ESC>P')) { inFormat = false; continue; }
        if (/^E\d+;F\d*;?$/.test(frame)) { inFormat = true; continue; }
        // Direct Graphics Mode (PRM Appendix E): emit a placeholder box for
        // each RLE bitmap. BarTender uses this for shapes; the ZPL cross-check
        // cares about layout, not the raster.
        if (frame === '<ESC>g0') { dgMode = true; continue; }
        if (dgMode) {
            if ([...frame].some(ch => ch.charCodeAt(0) === 0x28)) {
                dgMode = false;
                if (dgCount === 0) out.push('^FO50,50^GB400,200,2^FS');
                dgCount++;
            }
            continue;
        }
        if (!inFormat) continue;

        const hm = frame.match(/^([HBLWU])(\d*)/);
        if (!hm) continue;
        const kind = hm[1], id = hm[2] ? parseInt(hm[2], 10) : undefined;
        const params = paramsOf(frame.slice(hm[0].length));
        const [ox, oy] = intP(params, 'o', 0) ? [] : [];
        const oRaw = (params.find(([k]) => k === 'o')?.[1] || '0,0').split(',').map(Number);
        const f = Math.max(0, Math.min(3, intP(params, 'f', 0)));
        const data = resolveData(params, id);

        if (kind === 'H') {
            const font = (params.filter(([k]) => k === 'c').pop()?.[1] || '25');
            const outline = !['0', '1', '2', '7'].includes(font);
            const dims = outline
                ? (() => { const h = Math.max(8, Math.round((intP(params, 'k', 12) / 72) * dpi)); return { L: Math.max(1, data.length) * Math.round(h * 0.6), C: h }; })()
                : { L: Math.max(1, data.length) * 8 * intP(params, 'w', 1), C: 9 * intP(params, 'h', 1) };
            const [vx, vy] = visualTopLeft(oRaw[0], oRaw[1], f, dims.L, dims.C);
            out.push(`^FO${vx},${vy}`, `^FW${'NREB'[f] ?? 'N'}`, `^A0N,${dims.C},${Math.round(dims.C * 0.6)}`, `^FD${zplEscape(data)}^FS`, '^FWN');
        } else if (kind === 'B') {
            const cParts = (params.find(([k]) => k === 'c')?.[1] || '6').split(',');
            const sym = cParts[0];
            const hDots = intP(params, 'h', 50);
            const wMod = Math.max(1, intP(params, 'w', 2));
            const estW = Math.max(40, Math.round(data.length * 9 * wMod));
            const hri = intP(params, 'i', 1) !== 0 ? 'Y' : 'N';
            const [vx, vy] = visualTopLeft(oRaw[0], oRaw[1], f, estW, hDots);
            out.push(`^FO${vx},${vy}`, `^FW${'NREB'[f] ?? 'N'}`, `^BY${wMod},2.5,${hDots}`);
            // ^B3 is o,e,h,f,g: the second slot is the mod-43 check digit, not
            // the HRI flag. A Code 39 printer-generated check digit (c0 m=1/4/7)
            // is e=Y; the old form put the HRI flag in that slot instead.
            const c39ck = sym === '0' && ['1', '4', '7'].includes(cParts[1]) ? 'Y' : 'N';
            const symCmd = {
                '0': `^B3N,${c39ck},${hri},N,E`, '1': '^BAN,' + hri + ',N,N',
                '2': `^B2N,${hri},N,N`, '3': '^BNN,' + hri,
                '4': `^BKN,${hri},N,N`, '5': '^BIN,' + hri,
                '6': `^BCN,${hri},Y,N,N`,
                '7': ({ 13: '^BEN,' + hri, 8: '^B8N,' + hri, 12: '^BUN,' + hri })[data.replace(/\D/g, '').length] || '^BCN,' + hri,
                '12': `^B7N,${hri},4,5,60`, '17': `^BXN,${Math.max(3, wMod * 2)},200`,
            }[sym];
            if (symCmd) {
                out.push(symCmd, `^FD${zplEscape(data)}^FS`, '^FWN');
            } else {
                // A symbology with no ZPL counterpart. Dropping it silently made
                // the Labelary cross-check compare a label that had lost a bar
                // code against one that still had it, and the ink totals came
                // out closer than they should — a pass for the wrong reason.
                // The reader is told instead, and the payload is kept as text so
                // the area is not blank.
                out.push('^FX', `^FD[no ZPL equivalent for c${sym}]^FS`, '^FWN');
            }
        } else if (kind === 'L') {
            const len = intP(params, 'l', 100), th = Math.max(2, intP(params, 'w', 2));
            const [vx, vy] = visualTopLeft(oRaw[0], oRaw[1], f, len, th);
            out.push(`^FO${vx},${vy}`, `^GB${len},${th},${th}^FS`);
        } else if (kind === 'W') {
            const bw = intP(params, 'l', 100), bh = intP(params, 'h', 100), th = Math.max(1, intP(params, 'w', 2));
            const rParam = params.find(([k]) => k === 'r');
            const rIdx = rParam ? Math.max(0, Math.min(8, Math.round((parseInt(rParam[1], 10) * 2) / Math.min(bw, bh) * 8))) : 0;
            const [vx, vy] = visualTopLeft(oRaw[0], oRaw[1], f, bw, bh);
            out.push(`^FO${vx},${vy}`, `^GB${bw},${bh},${th}${rIdx ? `,${rIdx}` : ''}^FS`);
        } else if (kind === 'U') {
            // Graphic placement: emit a placeholder box sized from the
            // referenced G definition (ZPL cross-check cares about layout,
            // not the raster). Parse G dims from the stream's G frames.
            const gRef = intP(params, 'c', 0);
            const gFrame = frames.map(f => f.match(/^G\d+;x(\d+);y(\d+)/)).find(m => m);
            const gw = gFrame ? +gFrame[1] : intP(params, 'l', 100);
            const gh = gFrame ? +gFrame[2] : intP(params, 'h', 100);
            // BarTender split form stores print-head orientation: swap.
            const vw = gw, vh = gh;
            if (gFrame && gh > gw) { /* dims already portrait in header */ }
            const [vx, vy] = visualTopLeft(oRaw[0], oRaw[1], f, vw, vh);
            out.push(`^FO${vx},${vy}`, `^GB${Math.max(2, Math.round(vw * 0.5))},${Math.max(2, Math.round(vh * 0.5))},2^FS`);
        }
    }

    const rs = /(?:<RS>|\x1e)(\d+)/.exec(normalize(iplCode));
    if (rs) qty = parseInt(rs[1], 10);
    out.push(`^PQ${qty}`, '^XZ');
    return out.join('\n');
}

// CLI entry: node tools/ipl2zpl.mjs input.ipl [output.zpl] [dpi]
if (process.argv[1] && process.argv[1].endsWith('ipl2zpl.mjs')) {
    const [input, output, dpiArg] = process.argv.slice(2);
    if (!input) { console.error('usage: node tools/ipl2zpl.mjs input.ipl [output.zpl] [dpi]'); process.exit(1); }
    if (!fs.existsSync(input)) { console.error(`input not found: ${input}`); process.exit(1); }
    const dpi = parseInt(dpiArg || '203', 10);
    const zpl = iplToZpl(fs.readFileSync(input, 'utf8'), dpi);
    const dest = output || input.replace(/\.ipl$/i, '') + '.zpl';
    fs.writeFileSync(dest, zpl);
    console.log(`wrote ${dest} (${zpl.length} bytes @ ${dpi}dpi)`);
}
