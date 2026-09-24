// IPL Printer Language / code page support (PRM p.133 "<SI>ln", 2.70 p.139).
//
// A code page maps the 0x80-0xFF bytes of print data onto real characters. The
// pipeline carries byte-strings (one char per byte) so Direct Graphics payloads
// stay byte-exact, which makes this the step that turns bytes into text.
//
// The tables are bundled rather than delegated to TextDecoder on purpose: on
// Node 20 / ICU 76.1, 5 of these 9 labels decode WRONG (windows-1250 0xB1 ->
// U+00B1 instead of U+0105, windows-1252 0x84 -> U+0084 instead of U+201E, plus
// windows-1254/1257/1258). A committed table is identical in Node and the
// browser; TextDecoder is not. Generated from GNU iconv by
// tools/gen-codepages.mjs — tests/codePage.test.ts compares every byte against
// the goldens in testdata/codepages/.

/** A code page we can decode, plus the two families we deliberately do not. */
export interface CodePageInfo {
    /** Human label for the issues panel and the viewer settings readout. */
    label: string;
    /** 128 code points for bytes 0x80-0xFF, concatenated 4-digit hex. */
    table?: string;
    /**
     * True for n=0..9: the printer substitutes a small set of characters
     * (Appendix B), which is NOT a code page. Decoding must leave bytes alone.
     */
    resident?: boolean;
    /** True for n=30..33: CJK pages, not implemented. */
    cjk?: boolean;
}

/** Printer language n -> code page (PRM p.133-134, 2.70 p.139-140). */
export const CODE_PAGES: Record<number, CodePageInfo> = {
    0: { label: 'U.S.A.', resident: true },
    1: { label: 'United Kingdom', resident: true },
    2: { label: 'Germany', resident: true },
    3: { label: 'Denmark', resident: true },
    4: { label: 'France', resident: true },
    5: { label: 'Sweden', resident: true },
    6: { label: 'Italy', resident: true },
    7: { label: 'Spain', resident: true },
    8: { label: '8-Bit ASCII', resident: true },
    9: { label: 'Switzerland', resident: true },
    10: { label: 'CP850 — DOS Latin 1', table: '00c700fc00e900e200e400e000e500e700ea00eb00e800ef00ee00ec00c400c500c900e600c600f400f600f200fb00f900ff00d600dc00f800a300d800d7019200e100ed00f300fa00f100d100aa00ba00bf00ae00ac00bd00bc00a100ab00bb2591259225932502252400c100c200c000a9256325512557255d00a200a5251025142534252c251c2500253c00e300c3255a25542569256625602550256c00a400f000d000ca00cb00c8013100cd00ce00cf2518250c2588258400a600cc258000d300df00d400d200f500d500b500fe00de00da00db00d900fd00dd00af00b400ad00b1201700be00b600a700f700b800b000a800b700b900b300b225a000a0' },
    11: { label: 'CP1250 — Central Europe', table: '20acfffd201afffd201e202620202021fffd203001602039015a0164017d0179fffd20182019201c201d202220132014fffd21220161203a015b0165017e017a00a002c702d8014100a4010400a600a700a800a9015e00ab00ac00ad00ae017b00b000b102db014200b400b500b600b700b80105015f00bb013d02dd013e017c015400c100c2010200c40139010600c7010c00c9011800cb011a00cd00ce010e01100143014700d300d4015000d600d70158016e00da017000dc00dd016200df015500e100e2010300e4013a010700e7010d00e9011900eb011b00ed00ee010f01110144014800f300f4015100f600f70159016f00fa017100fc00fd016302d9' },
    12: { label: 'CP1251 — Cyrillic', table: '04020403201a0453201e20262020202120ac203004092039040a040c040b040f045220182019201c201d202220132014fffd21220459203a045a045c045b045f00a0040e045e040800a4049000a600a7040100a9040400ab00ac00ad00ae040700b000b104060456049100b500b600b704512116045400bb04580405045504570410041104120413041404150416041704180419041a041b041c041d041e041f0420042104220423042404250426042704280429042a042b042c042d042e042f0430043104320433043404350436043704380439043a043b043c043d043e043f0440044104420443044404450446044704480449044a044b044c044d044e044f' },
    13: { label: 'CP1252 — Latin 1, Western Europe', table: '20acfffd201a0192201e20262020202102c62030016020390152fffd017dfffdfffd20182019201c201d20222013201402dc21220161203a0153fffd017e017800a000a100a200a300a400a500a600a700a800a900aa00ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b900ba00bb00bc00bd00be00bf00c000c100c200c300c400c500c600c700c800c900ca00cb00cc00cd00ce00cf00d000d100d200d300d400d500d600d700d800d900da00db00dc00dd00de00df00e000e100e200e300e400e500e600e700e800e900ea00eb00ec00ed00ee00ef00f000f100f200f300f400f500f600f700f800f900fa00fb00fc00fd00fe00ff' },
    14: { label: 'CP1253 — Greek', table: '20acfffd201a0192201e202620202021fffd2030fffd2039fffdfffdfffdfffdfffd20182019201c201d202220132014fffd2122fffd203afffdfffdfffdfffd00a00385038600a300a400a500a600a700a800a9fffd00ab00ac00ad00ae201500b000b100b200b3038400b500b600b703880389038a00bb038c00bd038e038f0390039103920393039403950396039703980399039a039b039c039d039e039f03a003a1fffd03a303a403a503a603a703a803a903aa03ab03ac03ad03ae03af03b003b103b203b303b403b503b603b703b803b903ba03bb03bc03bd03be03bf03c003c103c203c303c403c503c603c703c803c903ca03cb03cc03cd03cefffd' },
    15: { label: 'CP1254 — Turkish', table: '20acfffd201a0192201e20262020202102c62030016020390152fffdfffdfffdfffd20182019201c201d20222013201402dc21220161203a0153fffdfffd017800a000a100a200a300a400a500a600a700a800a900aa00ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b900ba00bb00bc00bd00be00bf00c000c100c200c300c400c500c600c700c800c900ca00cb00cc00cd00ce00cf011e00d100d200d300d400d500d600d700d800d900da00db00dc0130015e00df00e000e100e200e300e400e500e600e700e800e900ea00eb00ec00ed00ee00ef011f00f100f200f300f400f500f600f700f800f900fa00fb00fc0131015f00ff' },
    16: { label: 'CP1255 — Hebrew', table: '20acfffd201a0192201e20262020202102c62030fffd2039fffdfffdfffdfffdfffd20182019201c201d20222013201402dc2122fffd203afffdfffdfffdfffd00a000a100a200a320aa00a500a600a700a800a900d700ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b900f700bb00bc00bd00be00bf05b005b105b205b305b405b505b605b705b805b905ba05bb05bc05bd05be05bf05c005c105c205c305f005f105f205f305f4fffdfffdfffdfffdfffdfffdfffd05d005d105d205d305d405d505d605d705d805d905da05db05dc05dd05de05df05e005e105e205e305e405e505e605e705e805e905eafffdfffd200e200ffffd' },
    17: { label: 'CP1256 — Arabic', table: '20ac067e201a0192201e20262020202102c6203006792039015206860698068806af20182019201c201d20222013201406a921220691203a0153200c200d06ba00a0060c00a200a300a400a500a600a700a800a906be00ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b9061b00bb00bc00bd00be061f06c1062106220623062406250626062706280629062a062b062c062d062e062f063006310632063306340635063600d7063706380639063a064006410642064300e0064400e2064506460647064800e700e800e900ea00eb0649064a00ee00ef064b064c064d064e00f4064f065000f7065100f9065200fb00fc200e200f06d2' },
    18: { label: 'CP1257 — Baltic Rim', table: '20acfffd201afffd201e202620202021fffd2030fffd2039fffd00a802c700b8fffd20182019201c201d202220132014fffd2122fffd203afffd00af02dbfffd00a0fffd00a200a300a4fffd00a600a700d800a9015600ab00ac00ad00ae00c600b000b100b200b300b400b500b600b700f800b9015700bb00bc00bd00be00e60104012e0100010600c400c501180112010c00c90179011601220136012a013b01600143014500d3014c00d500d600d701720141015a016a00dc017b017d00df0105012f0101010700e400e501190113010d00e9017a011701230137012b013c01610144014600f3014d00f500f600f701730142015b016b00fc017c017e02d9' },
    19: { label: 'CP1258 — Vietnamese', table: '20acfffd201a0192201e20262020202102c62030fffd20390152fffdfffdfffdfffd20182019201c201d20222013201402dc2122fffd203a0153fffdfffd017800a000a100a200a300a400a500a600a700a800a900aa00ab00ac00ad00ae00af00b000b100b200b300b400b500b600b700b800b900ba00bb00bc00bd00be00bf00c000c100c2010200c400c500c600c700c800c900ca00cb030000cd00ce00cf011000d1030900d300d401a000d600d700d800d900da00db00dc01af030300df00e000e100e2010300e400e500e600e700e800e900ea00eb030100ed00ee00ef011100f1032300f300f401a100f600f700f800f900fa00fb00fc01b020ab00ff' },
    20: { label: 'CP874 — Thai', table: '20acfffdfffdfffdfffd2026fffdfffdfffdfffdfffdfffdfffdfffdfffdfffdfffd20182019201c201d202220132014fffdfffdfffdfffdfffdfffdfffdfffd00a00e010e020e030e040e050e060e070e080e090e0a0e0b0e0c0e0d0e0e0e0f0e100e110e120e130e140e150e160e170e180e190e1a0e1b0e1c0e1d0e1e0e1f0e200e210e220e230e240e250e260e270e280e290e2a0e2b0e2c0e2d0e2e0e2f0e300e310e320e330e340e350e360e370e380e390e3afffdfffdfffdfffd0e3f0e400e410e420e430e440e450e460e470e480e490e4a0e4b0e4c0e4d0e4e0e4f0e500e510e520e530e540e550e560e570e580e590e5a0e5bfffdfffdfffdfffd' },
    30: { label: 'Code Page 932, Shift JIS, Japanese', cjk: true },
    31: { label: 'Code Page 936, GB 2312-80, Simplified Chinese', cjk: true },
    32: { label: 'Code Page 949, KSC5601, Korean Hangeul', cjk: true },
    33: { label: 'Code Page 950, Big 5, Traditional Chinese', cjk: true },
    40: { label: 'UTF-8' },
};

const REPLACEMENT = 0xfffd;

/**
 * Decode a byte-string under code page `n`.
 *
 * Unknown, resident (n=0..9) and CJK (n=30..33) pages return the input
 * untouched: guessing at those would corrupt text silently, and the resident
 * substitution table (Appendix B) is a separate, unimplemented feature.
 */
export function decodeCodePage(s: string, n: number | undefined): string {
    if (n === undefined || n === null) return s;
    if (n === 40) return decodeUtf8(s);
    const info = CODE_PAGES[n];
    if (!info || info.resident || info.cjk || !info.table) return s;

    const table = info.table;
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        // The pipeline's byte-string uses one char per BYTE, so every value in
        // U+0080-U+00FF is legitimately a byte here and must be decoded. A
        // char above U+00FF can only be real text (a user typing or pasting
        // "Preis 5€"), so pass it through: masking it to 0xff would turn the
        // Euro into 0xAC and print a quarter sign instead.
        if (code > 0xff) {
            out += s.charAt(i);
            continue;
        }
        if (code < 0x80) {
            out += s.charAt(i);
            continue;
        }
        const cp = parseInt(table.substr((code - 0x80) * 4, 4), 16);
        out += String.fromCodePoint(Number.isNaN(cp) ? REPLACEMENT : cp);
    }
    return out;
}

/** UTF-8 (n=40) over a byte-string, with U+FFFD for malformed sequences. */
function decodeUtf8(s: string): string {
    // Only chars in U+0000-U+00FF are bytes. A char above that is real text
    // the user typed or pasted, so it splits the input: each run of bytes is
    // UTF-8 decoded on its own and the literal chars keep their place.
    // Decoding one run at a time also keeps a byte run that ends mid-sequence
    // from swallowing a real character that followed it.
    const utf8 = new TextDecoder('utf-8');
    let out = '';
    let bytes: number[] = [];
    const flush = () => {
        if (bytes.length === 0) return;
        out += utf8.decode(new Uint8Array(bytes));
        bytes = [];
    };
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code > 0xff) {
            flush();
            out += s.charAt(i);
        } else {
            bytes.push(code);
        }
    }
    flush();
    return out;
}

/** One-line description for the viewer settings panel. */
export function describeCodePage(n: number): string {
    const info = CODE_PAGES[n];
    if (!info) return `Unknown (${n})`;
    if (info.cjk) return `${info.label} (n=${n}) — not decoded`;
    if (info.resident) return `${info.label} (n=${n}) — resident character substitution`;
    return `${info.label} (n=${n})`;
}
