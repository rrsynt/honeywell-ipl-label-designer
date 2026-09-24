// Print a BarTender format to a file by way of the IPL printer's file port.
//
// Two things had to be established first, both by experiment:
//
//  - The automation API cannot author a format. Every property write on a new
//    DesignObject is refused ("Object property is not supported"), and no
//    interface in Interop.BarTender.dll exposes a barcode symbology, so the
//    script language (IBtApplication.XMLScript) is the only surface that can
//    reach them.
//
//  - Print routing cannot use PrintToFile. A trial licence refuses it outright
//    (error 2610), and Windows refuses a spooler port whose name is a file path
//    from an unprivileged process. The route that works is the port itself:
//    `Add-PrinterPort -Name C:\Temp\ipl-out.ipl` followed by `Set-Printer`,
//    which does need an elevated process but then needs no licence at all.
//
// The printer must be assigned on the Format, not left to the script: with
// `<Printer>` inside <FormatSetup> the server reported an empty FormatSetup and
// fell back to Microsoft Print to PDF, which cannot show a dialog unattended.

using System;
using System.IO;
using BarTender;

class PrintToFile
{
    const string PrinterName = "Intermec PD43 (203 dpi) - IPL";
    const string IplPath = @"C:\Temp\ipl-out.ipl";

    static int Main(string[] args)
    {
        string btw = args.Length > 0 ? args[0]
            : @"C:\Program Files\Seagull\BarTender 2022\Templates\Shipping\PTI Voice Pick Code\PTI_Voice_Pick_Code.btw";
        if (!File.Exists(btw)) { Console.Error.WriteLine("no format: " + btw); return 2; }

        var app = new Application();
        try
        {
            app.Visible = false;
            var fmt = app.Formats.Open(btw, false, "");
            Console.WriteLine("opened objects=" + fmt.Objects.Count);

            fmt.Printer = PrinterName;
            fmt.PrinterFile = IplPath;
            Console.WriteLine("printer=[" + fmt.Printer + "]");
            Console.WriteLine("printerFile=[" + fmt.PrinterFile + "]");
            Console.WriteLine("copies=" + fmt.PrintSetup.IdenticalCopiesOfLabel);

            if (File.Exists(IplPath)) File.Delete(IplPath);
            Messages messages;
            fmt.Print("", false, -1, out messages);
            Report("print", messages);
            Console.WriteLine("ipl=" + IplPath + " exists=" + File.Exists(IplPath) +
                              (File.Exists(IplPath) ? " bytes=" + new FileInfo(IplPath).Length : ""));
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

    static void Report(string stage, Messages messages)
    {
        if (messages == null) { Console.WriteLine(stage + ": no messages"); return; }
        Console.WriteLine(stage + ": " + messages.Count + " message(s)");
        for (int i = 1; i <= messages.Count; i++)
        {
            var m = messages.Item(i);
            Console.WriteLine("  [" + m.Number + "] " + m.Message);
        }
    }
}
