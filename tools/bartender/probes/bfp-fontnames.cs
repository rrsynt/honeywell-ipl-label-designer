// Ground truth for the printer-resident outline faces whose metrics this
// project had never measured: IPL c23 (OCR A), c24 (OCR B size 2) and c69
// (Letter Gothic). c67 (Century Schoolbook) was closed 2026-09-28 by measuring
// a metric-identical free face; these three have no such substitute, so the
// answer has to come from the reference implementation.
//
// FontName/PointSize ARE settable on a text object (only the CONTENT is not --
// see README). Whether a name resolves to a printer-resident IPL font is the
// driver's business, so the resulting .ipl stream is the check: a face the
// driver does not know is rasterized instead of being emitted as `c<n>`.
//
//   csc.exe -r:"C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll" ^
//     -out:BuildFontProbe.exe BuildFontProbe.cs
//   BuildFontProbe.exe C:\Temp\bt-fonts

using System;
using System.Collections.Generic;
using System.IO;
using BarTender;

class BuildFontProbe
{
    const double MM = 25.4;

    class Spec
    {
        public string Name;
        public double PageW = 4, PageH = 3, Margin = 0.1;
        public List<Action<Format>> Objects = new List<Action<Format>>();
    }

    static void Try(string label, Action a)
    {
        try { a(); }
        catch (Exception ex) { Console.Error.WriteLine("  " + label + ": " + ex.Message.Split('\n')[0]); }
    }

    static void CreatePage(Application app, string btw, Spec s, string printer)
    {
        if (File.Exists(btw)) File.Delete(btw);
        var ci = System.Globalization.CultureInfo.InvariantCulture;
        string script =
            "<?xml version=\"1.0\" encoding=\"utf-8\"?><XMLScript Version=\"2.0\">" +
            "<Command Name=\"CreateFormat\">" +
            "<CreateFormat SaveAsFileName=\"" + btw + "\" Printer=\"" + printer + "\">" +
            "<Page Width=\"" + s.PageW.ToString(ci) + " in\" Height=\"" + s.PageH.ToString(ci) + " in\" Orientation=\"btPortrait\" />" +
            "<Layout Rows=\"1\" Columns=\"1\" />" +
            "<Margins Top=\"" + s.Margin.ToString(ci) + "\" Left=\"" + s.Margin.ToString(ci) +
            "\" Bottom=\"" + s.Margin.ToString(ci) + "\" Right=\"" + s.Margin.ToString(ci) + "\" />" +
            "</CreateFormat></Command></XMLScript>";
        Messages msgs;
        app.XMLScript(script, BtXMLSourceType.btXMLScriptString, out msgs);
        if (msgs != null && msgs.Count > 0)
            for (int i = 1; i <= msgs.Count; i++)
                Console.Error.WriteLine("  CreateFormat [" + msgs.Item(i).Number + "] " + msgs.Item(i).Message);
    }

    static int Main(string[] argv)
    {
        string outDir = argv.Length > 0 ? argv[0] : @"C:\Temp\bt-fonts";
        string printer = argv.Length > 1 ? argv[1] : "Intermec PD43 (203 dpi) - IPL";
        Directory.CreateDirectory(outDir);

        // Only the printer-resident names are interesting; "Arial" is the
        // control (a face the driver certainly cannot ask the printer for).
        var faces = new[] { "OCR A", "OCR B", "Letter Gothic", "Arial" };

        var app = new Application();
        try
        {
            app.Visible = false;
            foreach (string face in faces)
            {
                string safe = face.Replace(" ", "-");
                string btw = Path.Combine(outDir, "font-" + safe + ".btw");
                var spec = new Spec { Name = "font-" + safe };
                // One line of the SAME text at the SAME size, so any width
                // difference between the files is the face and nothing else.
                string f = face;
                spec.Objects.Add(fm =>
                {
                    var t = fm.Objects.Create(BtObjectType.btObjectText);
                    t.X = 0.15 * MM; t.Y = 0.15 * MM;
                    t.FontName = f;
                    t.FontSize = 12;
                });
                CreatePage(app, btw, spec, printer);

                // The writes must happen on the OPENED document and be saved
                // before anything can see them; a copy created by CreateFormat
                // has no objects, and closing without btSaveChanges discards
                // whatever was added.
                Try("open " + safe, () =>
                {
                    var fmt = app.Formats.Open(btw, false, "");
                    foreach (var add in spec.Objects) add(fmt);
                    Console.WriteLine(safe + ": objects=" + fmt.Objects.Count);
                    for (int i = 1; i <= fmt.Objects.Count; i++)
                    {
                        DesignObject o = fmt.Objects.Item(i);
                        Console.WriteLine("   obj" + i + " type=" + o.Type + " FontName=" + o.FontName + " size=" + o.FontSize);
                    }
                    fmt.Close(BtSaveOptions.btSaveChanges);
                });
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("ERR: " + e.Message.Split('\n')[0]);
            return 1;
        }
        finally
        {
            app.Quit(BtSaveOptions.btDoNotSaveChanges);
        }
        return 0;
    }
}
