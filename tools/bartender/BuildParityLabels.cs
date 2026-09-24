// Generate BarTender formats with objects at ARBITRARY geometry, so "does our
// preview match for any object, any size, anywhere?" can be answered by
// measurement instead of by the two hand-placed samples that exist today.
//
// WHAT THE 2026-09-24 PROBES ESTABLISHED (see probes/ for the dead ends):
//
//   Object placement is gated on the DOCUMENT, not on the object.
//     Formats.Add()                        -> Create() succeeds, every property
//                                             write throws "This property is
//                                             allowed only when running document
//                                             event scripts". SaveAs FIRST does
//                                             not help.
//     Formats.Open(existing.btw)           -> placement works.
//     XMLScript CreateFormat (writes .btw) -> then Open it and placement works.
//   So the document must come from CreateFormat, not from Add(). The script
//   language is reachable through IBtApplication.XMLScript.
//
//   Object CONTENT cannot be set. Create(text) yields BarTender's default
//   "Sample Text"; SetXML and SetProperty are accepted and then SILENTLY
//   IGNORED outside a document-event script (verified by reading the value
//   back). So the sweep is GEOMETRY-only -- positions, sizes, rotations, page
//   stocks, margins, and object types -- which is what geometry parity rests
//   on. Data content stays the two hand-placed samples' job.
//
// Build:
//   "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo \
//     -r:"C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll" \
//     -out:BuildParityLabels.exe BuildParityLabels.cs
//
// Usage:
//   BuildParityLabels.exe <outDir> [printer]
//   -> <outDir>\<case>.btw plus <outDir>\manifest.tsv
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using BarTender;

class BuildParityLabels
{
    class Spec
    {
        public string Name;
        public double PageW, PageH, Margin;
        public string Orientation = "btPortrait";
        public List<Action<Format>> Objects = new List<Action<Format>>();
    }

    static void Try(string label, Action a)
    {
        try { a(); }
        catch (Exception ex) { Console.Error.WriteLine("  " + label + ": " + ex.Message.Split('\n')[0]); }
    }

    /// <summary>Creates the page via the SCRIPT language, because that is the only
    /// route that yields a document whose design objects accept writes.</summary>
    static void CreatePage(Application app, string btw, Spec s, string printer)
    {
        if (File.Exists(btw)) File.Delete(btw);
        // Invariant formatting is mandatory, not cosmetic: under a comma-decimal
        // locale `double.ToString()` renders 0.1 as "0,1", and the schema then
        // rejects the whole script with error 3908 (which is why a hand-typed
        // "0.1" works and a generated one does not).
        var ci = System.Globalization.CultureInfo.InvariantCulture;
        string w = s.PageW.ToString(ci), h = s.PageH.ToString(ci), m = s.Margin.ToString(ci);
        string script =
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><XMLScript Version=\"2.0\">" +
            "<Command Name=\"CreateFormat\">" +
            "<CreateFormat SaveAsFileName=\"" + btw + "\" Printer=\"" + printer + "\">" +
            "<Page Width=\"" + w + " in\" Height=\"" + h + " in\" Orientation=\"" + s.Orientation + "\" />" +
            "<Layout Rows=\"1\" Columns=\"1\" />" +
            "<Margins Top=\"" + m + "\" Left=\"" + m + "\" Bottom=\"" + m + "\" Right=\"" + m + "\" />" +
            "</CreateFormat></Command></XMLScript>";
        Messages msgs;
        app.XMLScript(script, BtXMLSourceType.btXMLScriptString, out msgs);
        if (msgs != null && msgs.Count > 0)
            for (int i = 1; i <= msgs.Count; i++)
                Console.Error.WriteLine("  CreateFormat [" + msgs.Item(i).Number + "] " + msgs.Item(i).Message);
    }

    static int Main(string[] argv)
    {
        string outDir = argv.Length > 0 ? argv[0] : @"C:\Temp\bt-sweep";
        string printer = argv.Length > 1 ? argv[1] : "Intermec PD43 (203 dpi) - IPL";
        Directory.CreateDirectory(outDir);
        // The interop reports MeasurementUnits = btUnitsMillimeters on this install
        // regardless of what the format declares, and every DesignObject X/Y/
        // Width/Height/LineStart*/LineEnd* is in that unit. A value meant as
        // inches therefore lands 25.4x too small and prints off-page -- which is
        // what the first sweep produced (previews were blank). Specs below are
        // written in inches for readability, so convert once, here.
        const double MM = 25.4;

        var specs = new List<Spec>();

        // A lattice: any position-dependent error (a rounding rule, an origin
        // flip, a rotation anchor) shows up as a pattern rather than one outlier.
        var grid = new Spec { Name = "grid", PageW = 4, PageH = 4, Margin = 0.1 };
        for (int gy = 0; gy < 4; gy++)
            for (int gx = 0; gx < 4; gx++)
            {
                double x = 0.2 + gx * 0.9, y = 0.2 + gy * 0.9;
                grid.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = x*MM; o.Y = y*MM; o.Width = 0.5*MM; o.Height = 0.5*MM; o.LineThickness = 1; o.FillColor = 0xFFFFFF; });
            }
        specs.Add(grid);

        // A size sweep, bottom-left anchored so size is the only variable.
        var sizes = new Spec { Name = "sizes", PageW = 6, PageH = 4, Margin = 0.1 };
        foreach (double s2 in new double[] { 0.2, 0.4, 0.6, 0.9, 1.2, 1.6, 2.0, 2.6, 3.2 })
        {
            double sz = s2;
            sizes.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 0.15*MM; o.Y = 0.15*MM; o.Width = sz*MM; o.Height = sz*MM; o.LineThickness = 2; o.FillColor = 0xFFFFFF; });
        }
        specs.Add(sizes);

        // Eight rotation angles about a common pivot -- the case that catches a
        // rotation-direction or anchor error, which no hand-placed sample covers
        // because none of them rotate an object.
        var rots = new Spec { Name = "rotations", PageW = 4, PageH = 4, Margin = 0.1 };
        foreach (double ang in new double[] { 0, 45, 90, 135, 180, 225, 270, 315 })
        {
            double a = ang;
            rots.Objects.Add(f => {
                var o = f.Objects.Create(BtObjectType.btObjectBox);
                o.X = 2.0*MM; o.Y = 2.0*MM; o.Width = 1.2*MM; o.Height = 0.6*MM;
                o.RotationAngle = a; o.LineThickness = 2; o.FillColor = 0xFFFFFF;
            });
        }
        specs.Add(rots);

        // Four very different stocks with identical relative content.
        foreach (var ps in new[] {
            new { N = "page-2x1", W = 2.0, H = 1.0 },
            new { N = "page-4x2", W = 4.0, H = 2.0 },
            new { N = "page-4x6", W = 4.0, H = 6.0 },
            new { N = "page-8x4", W = 8.0, H = 4.0 } })
        {
            var spec = new Spec { Name = ps.N, PageW = ps.W, PageH = ps.H, Margin = 0.1 };
            spec.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 0.1*MM; o.Y = 0.1*MM; o.Width = ps.W*0.3*MM; o.Height = ps.H*0.3*MM; o.LineThickness = 1; o.FillColor = 0xFFFFFF; });
            spec.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = ps.W*0.5*MM; o.Y = ps.H*0.5*MM; o.Width = ps.W*0.4*MM; o.Height = ps.H*0.4*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; });
            spec.Objects.Add(f => { var t = f.Objects.Create(BtObjectType.btObjectText); t.X = 0.15*MM; t.Y = ps.H*0.8*MM; t.FontName = "Arial"; t.FontSize = 10; });
            specs.Add(spec);
        }

        // All five object types on one label.
        var mixed = new Spec { Name = "mixed", PageW = 4, PageH = 2, Margin = 0.1 };
        mixed.Objects.Add(f => { var t = f.Objects.Create(BtObjectType.btObjectText); t.X = 0.15*MM; t.Y = 0.15*MM; t.FontName = "Arial"; t.FontSize = 12; });
        mixed.Objects.Add(f => { var b = f.Objects.Create(BtObjectType.btObjectBox); b.X = 0.15*MM; b.Y = 0.8*MM; b.Width = 1.5*MM; b.Height = 0.9*MM; b.LineThickness = 2; b.FillColor = 0xFFFFFF; });
        mixed.Objects.Add(f => { var t = f.Objects.Create(BtObjectType.btObjectText); t.X = 0.25*MM; t.Y = 1.1*MM; t.FontName = "Arial"; t.FontSize = 8; });
        mixed.Objects.Add(f => { var bc = f.Objects.Create(BtObjectType.btObjectBarcode); bc.X = 2.0*MM; bc.Y = 0.3*MM; bc.Width = 1.8*MM; bc.Height = 1.2*MM; });
        mixed.Objects.Add(f => { var l = f.Objects.Create(BtObjectType.btObjectLine); l.X = 0.2*MM; l.Y = 1.75*MM; l.Width = 3.5*MM; l.Height = 0.0; l.LineThickness = 1; });
        specs.Add(mixed);

        // Corners, edges, and deliberate overhangs -- the clipping question the
        // existing samples never reach.
        var edges = new Spec { Name = "edges", PageW = 3, PageH = 3, Margin = 0.05 };
        foreach (var e in new[] {
            new { X = 0.0, Y = 0.0 }, new { X = 2.0, Y = 0.0 },
            new { X = 0.0, Y = 2.0 }, new { X = 2.0, Y = 2.0 },
            new { X = -0.4, Y = 0.5 }, new { X = 2.6, Y = 0.5 },
            new { X = 1.0, Y = -0.4 }, new { X = 1.0, Y = 2.6 } })
        {
            double x = e.X, y = e.Y;
            edges.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = x*MM; o.Y = y*MM; o.Width = 0.8*MM; o.Height = 0.8*MM; o.LineThickness = 2; o.FillColor = 0xFFFFFF; });
        }
        specs.Add(edges);

        // Landscape stock, to check the page-turn model the audit pinned for one
        // hand-built format only.
        var land = new Spec { Name = "landscape", PageW = 6, PageH = 2, Margin = 0.1, Orientation = "btLandscape" };
        for (int i = 0; i < 6; i++)
        {
            double x = 0.2 + i * 0.95;
            land.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = x*MM; o.Y = 0.3*MM; o.Width = 0.7*MM; o.Height = 1.3*MM; o.LineThickness = 2; o.FillColor = 0xFFFFFF; });
        }
        specs.Add(land);

        // An ASYMMETRIC rotation case. The `rotations` lattice is 180-fold
        // symmetric (angles 0/180, 45/225, 90/270, 135/315 draw identically), so
        // a horizontal mirror and a vertical mirror are indistinguishable there --
        // both scored 97%. Boxes are symmetric too, so the shape cannot tell the
        // two apart either. BarTender exposes btObjectEllipse, btObjectRichText,
        // btObjectTable and btObjectGridLayout, but no triangle, so asymmetry has
        // to come from SIZE and POSITION: three rectangles of different heights
        // at different distances from the shared pivot, rotated together. That
        // makes "mirrored horizontally" and "mirrored vertically" produce visibly
        // different pictures, so a single comparison can say which axis is wrong.
        var asym = new Spec { Name = "rot-asym", PageW = 4, PageH = 4, Margin = 0.1 };
        asym.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 1.6*MM; o.Y = 1.6*MM; o.Width = 0.5*MM; o.Height = 1.6*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; o.RotationAngle = 30; });
        asym.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 2.4*MM; o.Y = 1.9*MM; o.Width = 0.4*MM; o.Height = 1.0*MM; o.LineThickness = 2; o.FillColor = 0xFFFFFF; o.RotationAngle = 30; });
        asym.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 2.9*MM; o.Y = 2.3*MM; o.Width = 0.3*MM; o.Height = 0.4*MM; o.LineThickness = 1; o.FillColor = 0xFFFFFF; o.RotationAngle = 30; });
        // An unrotated control with the same shapes, so any mirror can be told
        // apart from a rotation error in the first place.
        asym.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 0.3*MM; o.Y = 3.2*MM; o.Width = 0.5*MM; o.Height = 1.0*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; });
        asym.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 1.0*MM; o.Y = 3.3*MM; o.Width = 0.4*MM; o.Height = 0.6*MM; o.LineThickness = 2; o.FillColor = 0xFFFFFF; });
        specs.Add(asym);

        // SINGLE-OBJECT isolation cases. Every case above packs several objects
        // into one Direct Graphics payload, so no scoring method can tell "this
        // object is misplaced" from "this object drifted onto that one" -- an
        // earlier round of transform matching "found" a 94% mirror match that was
        // really our rotated group landing on the unrotated control group, and
        // `edges` (no rotated objects at all) scored 89% for the same wrong
        // transform. One object per format makes every comparison unambiguous.
        var one0 = new Spec { Name = "one-box", PageW = 3, PageH = 3, Margin = 0.1 };
        one0.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 0.5*MM; o.Y = 0.5*MM; o.Width = 2.0*MM; o.Height = 1.5*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; });
        specs.Add(one0);

        var one30 = new Spec { Name = "one-rot30", PageW = 3, PageH = 3, Margin = 0.1 };
        one30.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 1.0*MM; o.Y = 1.0*MM; o.Width = 1.2*MM; o.Height = 0.6*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; o.RotationAngle = 30; });
        specs.Add(one30);

        var one45 = new Spec { Name = "one-rot45", PageW = 3, PageH = 3, Margin = 0.1 };
        one45.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 1.0*MM; o.Y = 1.0*MM; o.Width = 1.2*MM; o.Height = 0.6*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; o.RotationAngle = 45; });
        specs.Add(one45);

        var one90 = new Spec { Name = "one-rot90", PageW = 3, PageH = 3, Margin = 0.1 };
        one90.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 1.0*MM; o.Y = 1.0*MM; o.Width = 1.2*MM; o.Height = 0.6*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; o.RotationAngle = 90; });
        specs.Add(one90);

        var oneT = new Spec { Name = "one-text", PageW = 3, PageH = 3, Margin = 0.1 };
        oneT.Objects.Add(f => { var t = f.Objects.Create(BtObjectType.btObjectText); t.X = 0.4*MM; t.Y = 1.2*MM; t.FontName = "Arial"; t.FontSize = 14; });
        specs.Add(oneT);

        // The same single box on a LANDSCAPE page, as a control for the page-turn
        // model. One-box declares <ESC>C<SI>W591 and BarTender previews it turned
        // 90 degrees because the page setup rotates the stock, not the stream.
        var oneLand = new Spec { Name = "one-box-landscape", PageW = 4, PageH = 2, Margin = 0.1, Orientation = "btLandscape" };
        oneLand.Objects.Add(f => { var o = f.Objects.Create(BtObjectType.btObjectBox); o.X = 0.6*MM; o.Y = 0.5*MM; o.Width = 2.4*MM; o.Height = 0.9*MM; o.LineThickness = 3; o.FillColor = 0xFFFFFF; });
        specs.Add(oneLand);


        var app = new Application();
        try
        {
            app.Visible = false;
            var manifest = new StringBuilder();

            foreach (var s in specs)
            {
                string btw = Path.Combine(outDir, s.Name + ".btw");
                CreatePage(app, btw, s, printer);
                if (!File.Exists(btw)) { Console.Error.WriteLine(s.Name + ": CreateFormat produced no file"); continue; }

                var fmt = app.Formats.Open(btw, false, "");
                int placed = 0, failed = 0;
                foreach (var place in s.Objects)
                {
                    try { place(fmt); placed++; }
                    catch (Exception ex)
                    {
                        failed++;
                        Console.Error.WriteLine("  " + s.Name + ": placement " + (placed + failed) +
                            " failed: " + ex.Message.Split('\n')[0]);
                    }
                }

                fmt.Save();
                Console.WriteLine(string.Format("{0,-12} objects={1,3} placed={2,3} failed={3,3} page={4}x{5}in",
                    s.Name, fmt.Objects.Count, placed, failed, s.PageW, s.PageH));
                manifest.AppendLine(string.Join("\t", new string[] {
                    s.Name, fmt.Objects.Count.ToString(), placed.ToString(), btw }));
                fmt.Close(BtSaveOptions.btDoNotSaveChanges);
            }

            File.WriteAllText(Path.Combine(outDir, "manifest.tsv"), manifest.ToString());
            Console.WriteLine("NOTE: field DATA cannot be set by automation (accepted then silently");
            Console.WriteLine("      ignored outside document-event scripts), so text fields carry");
            Console.WriteLine("      BarTender's default \"Sample Text\" and barcodes their default");
            Console.WriteLine("      payload. This sweep is GEOMETRY-only: position, size, rotation,");
            Console.WriteLine("      object type, page stock, margins.");
        }
        catch (Exception ex) { Console.Error.WriteLine("EXCEPTION: " + ex.Message); return 1; }
        finally { app.Quit(BtSaveOptions.btDoNotSaveChanges); }
        return 0;
    }
}
