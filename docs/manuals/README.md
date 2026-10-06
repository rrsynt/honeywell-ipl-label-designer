# Printer manuals — what lives here and what does not

The vendor PDFs/CHM manuals are **not committed** (copyrighted by
Honeywell, Datamax-O'Neil, TSC, Zebra and Seagull). Keep your own copies in
this directory — file names below are the exact names the code comments and
tests refer to:

| File | Source |
|---|---|
| `IPL_2.70_Programmers_Reference_Manual.pdf` | Honeywell support downloads (search "IPL 2.70") |
| `IPL_Programmers_Reference_Manual.pdf` + `_066396-003.pdf` | Honeywell support downloads |
| `IPL_4400_Reference_Manual.pdf` (+ `.txt` extract, committed) | Honeywell support downloads |
| `IPL_Developers_Guide.pdf` (+ `.txt` extract, committed) | Honeywell support downloads |
| `IPL_Migration_Considerations_PM43_PC43_TechBrief.pdf` | Honeywell tech briefs |
| `IPL_Firmware_Release_Notes_K10_v9_P10_v9.pdf` | Honeywell firmware notes |
| `IPL_Command_Reference_Manual.chm` + `IPL_Command_Reference_K10_937-028-003/` | Intermec K10 reference (extracted `.htm` pages ARE committed) |
| `EPL2_Programmers_Manual_980352-001.pdf` (+ `.txt` extract, committed) | Zebra support downloads |
| `TSPL_Programming_Guide_P1139068-01EN.pdf` | TSC support downloads |
| `TSPL_TSPL2_Programming_Manual_TSC_2014.pdf` (+ `.txt` extract, committed) | TSC support downloads |
| `DPL_Honeywell_Fiji_CommandReference.pdf` | Honeywell Fiji platform docs |
| `DPL_Datamax_ClassSeries_Manual_88-2316-01.pdf` | Datamax-O'Neil Class Series |
| `DPL_Datamax_ClassSeries2_Manual_88-2341-01.pdf` | Datamax-O'Neil Class Series 2 |
| `DPL_Datamax_Programmers_Manual_88-2247-01.pdf` | Datamax-O'Neil programmers manual |

What IS committed: the `.txt` extracts the tests actually read
(`TSPL_Programming_Guide_*_outline.txt`, `EPL2_*.txt`, `IPL_*.txt`),
the extracted K10 `.htm` pages, `IPL-CHEATSHEET.md`, `IPL-RENDER-SPEC.md`,
`chm_dir.json`, the `Real_IPL_Streams/` + `IPL_Samples_Real/` captures, and
`DPL_Reference_Sources/` (third-party notes, kept for provenance with their
own README).

`tools/bartender/*.exe` are local builds of the committed `.cs` sources
(need BarTender + printer drivers on Windows); rebuild them, don't commit them.
Same for `docs/manuals/7zr.exe` — install 7-Zip normally.
