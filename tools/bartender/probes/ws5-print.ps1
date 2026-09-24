# Workstream 5: drive BarTender through IDispatch by dispid.
#
# Three routes fail here. The PowerShell COM adapter returns empty values and
# an RCW that implements none of the interop interfaces, so the typed wrappers
# cannot be cast onto it. InvokeMember by name reaches the real properties,
# but LabelWidth's setter takes a BtUnits argument the interop marks
# [Optional], and InvokeMember as SetProperty drops it — the server then says
# "parameter not optional". The accessor names set_LabelWidth/get_LabelWidth
# exist only in the interop, not on the COM server (DISP_E_UNKNOWNNAME).
#
# The dispid is the one identifier the type library and the server share, so
# the call goes straight to IDispatch.Invoke.
$ErrorActionPreference = 'Continue'
Add-Type -Path 'C:\Program Files\Seagull\BarTender 2022\Interop.BarTender.dll'

if (-not ('Ipl.Dispatch' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Ipl {
    public static class Dispatch {
        const int LOCALE_SYSTEM_DEFAULT = 0x0800;
        const int DISPATCH_METHOD = 1;
        const int DISPATCH_PROPERTYGET = 2;
        const int DISPATCH_PROPERTYPUT = 4;

        // A VARIANT is 16 bytes on x86 and 24 on x64. Size it the way the
        // marshaller does instead of hardcoding the stride.
        [StructLayout(LayoutKind.Sequential)]
        struct VariantSlot { public short vt; public short r1; public short r2; public short r3; public IntPtr p1; public IntPtr p2; }

        [DllImport("oleaut32.dll", PreserveSig = true)]
        static extern int VariantClear(IntPtr pvarg);

        public static object Invoke(object com, int dispid, bool put, params object[] args) {
            var unk = Marshal.GetIDispatchForObject(com);
            var slots = new VariantSlot[0];
            var dp = new DISPPARAMS();
            try {
                var disp = (IDispatch)Marshal.GetObjectForIUnknown(unk);
                int flags = put ? DISPATCH_PROPERTYPUT : DISPATCH_PROPERTYGET | DISPATCH_METHOD;
                if (args != null && args.Length > 0) {
                    // IDispatch wants arguments in reverse order.
                    slots = new VariantSlot[args.Length];
                    for (int i = 0; i < args.Length; i++) slots[i] = new VariantSlot();
                    var pinned = GCHandle.Alloc(slots, GCHandleType.Pinned);
                    try {
                        dp.cArgs = args.Length;
                        dp.rgvarg = pinned.AddrOfPinnedObject();
                        int stride = Marshal.SizeOf(typeof(VariantSlot));
                        for (int i = 0; i < args.Length; i++) {
                            Marshal.GetNativeVariantForObject(args[args.Length - 1 - i],
                                new IntPtr(dp.rgvarg.ToInt64() + (long)stride * i));
                        }
                        return DoInvoke(disp, dispid, flags, ref dp, put);
                    } finally { pinned.Free(); }
                }
                return DoInvoke(disp, dispid, flags, ref dp, put);
            } finally {
                if (dp.rgdispidNamedArgs != IntPtr.Zero) Marshal.FreeCoTaskMem(dp.rgdispidNamedArgs);
                Marshal.Release(unk);
            }
        }

        static object DoInvoke(IDispatch disp, int dispid, int flags, ref DISPPARAMS dp, bool put) {
            if (put) {
                dp.cNamedArgs = 1;
                dp.rgdispidNamedArgs = Marshal.AllocCoTaskMem(4);
                Marshal.WriteInt32(dp.rgdispidNamedArgs, -3); // DISPID_PROPERTYPUT
            }
            IntPtr rawResult = IntPtr.Zero;
            var ex = new EXCEPINFO();
            int err;
            Guid g = Guid.Empty;
            int hr = disp.Invoke(dispid, ref g, LOCALE_SYSTEM_DEFAULT, flags,
                ref dp, out rawResult, ref ex, out err);
            if (hr != 0) throw new COMException(
                "Invoke dispid " + dispid + " hr=0x" + hr.ToString("X") + " " + ex.bstrDescription, hr);
            if (rawResult == IntPtr.Zero) return null;
            // The server hands back a VARIANT, not an object. Handing the raw
            // pointer to an `object` slot would let the CLR read 8 bytes where
            // 24 are written on x64, which overruns the stack.
            try { return Marshal.GetObjectForNativeVariant(rawResult); }
            finally { VariantClear(rawResult); }
        }
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
     Guid("00020400-0000-0000-C000-000000000046")]
    interface IDispatch {
        int Reserved1(); int Reserved2(); int Reserved3();
        int GetTypeInfoCount(out int pctinfo);
        int GetTypeInfo(int iTInfo, int lcid, out IntPtr ppTInfo);
        int GetIDsOfNames(ref Guid riid, string[] rgszNames, int cNames, int lcid, int[] rgDispId);
        int Invoke(int dispIdMember, ref Guid riid, int lcid, int dwFlags,
            ref DISPPARAMS pDispParams, out IntPtr pVarResult, ref EXCEPINFO pExcepInfo, out int puArgErr);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DISPPARAMS {
        public IntPtr rgvarg;
        public IntPtr rgdispidNamedArgs;
        public int cArgs;
        public int cNamedArgs;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EXCEPINFO {
        public short wCode; public short wReserved;
        [MarshalAs(UnmanagedType.BStr)] public string bstrSource;
        [MarshalAs(UnmanagedType.BStr)] public string bstrDescription;
        [MarshalAs(UnmanagedType.BStr)] public string bstrHelpFile;
        public int dwHelpContext; public IntPtr pvReserved; public IntPtr pfnDeferredFillIn; public int scode;
    }
}
'@
}

$app = New-Object 'BarTender.ApplicationClass'
$app.Visible = $false
$get = [Reflection.BindingFlags]::GetProperty
function Get($o, $n) { $o.GetType().InvokeMember($n, $get, $null, $o, $null) }

try {
    $fmt = $app.Formats.Add()
    $fmt.GetType().InvokeMember('Printer', [Reflection.BindingFlags]::SetProperty, $null, $fmt,
        @('Intermec PD43 (203 dpi) - IPL'))
    Write-Output ("printer=[" + (Get $fmt 'Printer') + "]")

    $page = Get $fmt 'PageSetup'
    # dispid 8 LabelSizeManual, 18 LabelWidth, 19 LabelHeight (from the type lib).
    [Ipl.Dispatch]::Invoke($page, 8, $true, $true) | Out-Null
    $mm = [int][BarTender.BtUnits]::btUnitsMillimeters
    [Ipl.Dispatch]::Invoke($page, 18, $true, $mm, ([single]100)) | Out-Null
    [Ipl.Dispatch]::Invoke($page, 19, $true, $mm, ([single]65)) | Out-Null
    $w = [Ipl.Dispatch]::Invoke($page, 18, $false, $mm)
    $h = [Ipl.Dispatch]::Invoke($page, 19, $false, $mm)
    Write-Output ("label=" + $w + "x" + $h + "mm")
} catch {
    $e = $_.Exception
    $chain = @()
    while ($e) { $chain += $e.GetType().Name + ": " + $e.Message; $e = $e.InnerException }
    Write-Output ("ERR: " + ($chain -join " <- "))
}

$app.Quit(1)
Write-Output "DONE"
