# Ask the COM server itself which names it recognises. The interop says
# "Objects" is a property, but the server returns null for it.
$ErrorActionPreference = 'Continue'
if (-not ('Ipl.NameLookup' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Ipl {
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("00020400-0000-0000-C000-000000000046")]
    interface IDispatch {
        int Reserved1(); int Reserved2(); int Reserved3();
        int GetTypeInfoCount(out int pctinfo);
        int GetTypeInfo(int iTInfo, int lcid, out IntPtr ppTInfo);
        int GetIDsOfNames(ref Guid riid, [MarshalAs(UnmanagedType.LPArray, ArraySubType = UnmanagedType.LPWStr)] string[] names,
            int count, int lcid, [Out] int[] dispids);
    }
    public static class NameLookup {
        public static string Lookup(object com, string name) {
            IntPtr unk = Marshal.GetIDispatchForObject(com);
            try {
                var disp = (IDispatch)Marshal.GetObjectForIUnknown(unk);
                Guid g = Guid.Empty;
                int[] ids = new int[1];
                int hr = disp.GetIDsOfNames(ref g, new string[] { name }, 1, 0x0400, ids);
                return name + " hr=0x" + hr.ToString("X8") + " dispid=" + ids[0];
            } finally { Marshal.Release(unk); }
        }
    }
}
'@
}
Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'
$app = New-Object 'BarTender.ApplicationClass'
$app.Visible = $false
try {
    $fmt = $app.Formats.Add()
    foreach ($name in @('Objects', 'DesignObjects', 'PageSetup', 'PrintSetup', 'NamedSubStrings', 'Databases', 'Printer')) {
        Write-Output ([Ipl.NameLookup]::Lookup($fmt, $name))
    }
} catch {
    $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
    Write-Output ("ERR: " + $e.Message)
}
$app.Quit(1)
Write-Output "DONE"
