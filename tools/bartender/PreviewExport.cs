// Export a format's print preview to a PNG, with no printer and no license gate.
//
// The earlier failure of this call was "Access to file ... was denied", and the
// output path was inside a directory whose name contains a space and
// parentheses -- BarTender's own path handling is the suspect, not permissions.
// So the export target is a plain path and the caller reports what landed.
//
// This is the one half of Workstream 5 that does not need PrintToFile, which a
// trial license refuses: a reference image for any .btw on disk.

using System;
using System.IO;
using BarTender;

class PreviewExport
{
    static int Main(string[] args)
    {
        if (args.Length < 1) { Console.Error.WriteLine("usage: PreviewExport <format.btw> [outDir]"); return 2; }
        string format = args[0];
        string outDir = args.Length > 1 ? args[1] : @"C:\Temp\bt-preview";
        if (!File.Exists(format)) { Console.Error.WriteLine("no format: " + format); return 2; }
        Directory.CreateDirectory(outDir);

        var app = new Application();
        try
        {
            app.Visible = false;
            var fmt = app.Formats.Open(format, false, "");
            Console.WriteLine("opened objects=" + fmt.Objects.Count);

            string name = "preview.png";
            Messages messages;
            var result = fmt.ExportPrintPreviewToImage(
                outDir, name, "png", BtColors.btColorsMono, 203, 0xFFFFFF,
                BtSaveOptions.btDoNotSaveChanges, false, false, out messages);

            Report(result, messages);
            foreach (string f in Directory.GetFiles(outDir))
                Console.WriteLine("  wrote " + f + " bytes=" + new FileInfo(f).Length);
        }
        catch (Exception e)
        {
            Console.WriteLine("ERR: " + e.Message.Split('\n')[0]);
            return 1;
        }
        finally
        {
            app.Quit(BtSaveOptions.btDoNotSaveChanges);
        }
        return 0;
    }

    static void Report(BtPrintResult result, Messages messages)
    {
        Console.WriteLine("result=" + result);
        if (messages == null) { Console.WriteLine("no messages"); return; }
        for (int i = 1; i <= messages.Count; i++)
        {
            var m = messages.Item(i);
            Console.WriteLine("  [" + m.Number + "] " + m.Message);
        }
    }
}
