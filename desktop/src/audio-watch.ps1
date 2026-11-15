# HELPER's avatar: is some app playing media, and how loud are the speakers right now. Run by audio-watch.js.
# Prints only two kinds of line on stdout:
#   {"p":1} / {"p":0}   some app is playing / nothing is (only when that changes, and once at start)
#   {"l":0.420}         the speakers' peak right now, 0..1, about 30 a second, only after "rate 30"
# Reads commands on stdin: "rate 30" | "rate 0" | "ignore id1,id2" | "quit". Exits when stdin closes.
#
# What it never does: it never asks Windows for the song (no title, artist, album, picture or position: only the
# playback state of each session), never opens an audio stream (the level is the peak Windows already measures for
# its volume mixer, read through IAudioMeterInformation), and never writes anything anywhere. Errors are swallowed.
# ASCII only (Windows PowerShell 5.1 reads scripts as ANSI).
$ErrorActionPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace HelperAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class DeviceEnumeratorCom { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  // The volume mixer's meter: a peak number, not audio.
  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }

  public static class Watch {
    static readonly object gate = new object();
    public static volatile int Hz = 0;
    public static volatile string[] Ignore = new string[0];
    static IAudioMeterInformation meter;
    static DateTime meterAt = DateTime.MinValue;

    public static void Emit(string line) {
      lock (gate) {
        try { Console.Out.Write(line + "\n"); Console.Out.Flush(); } catch { Environment.Exit(0); }
      }
    }

    // The default speakers (render, multimedia role). Opened again every few seconds: headphones may be plugged in.
    static IAudioMeterInformation Open() {
      try {
        var en = (IDeviceEnumerator)new DeviceEnumeratorCom();
        IDevice dev;
        if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0 || dev == null) return null;
        Guid iid = typeof(IAudioMeterInformation).GUID;
        object o;
        if (dev.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
        return o as IAudioMeterInformation;
      } catch { return null; }
    }

    static void MeterLoop() {
      while (true) {
        int hz = Hz;
        if (hz <= 0) { meter = null; Thread.Sleep(200); continue; }
        if (meter == null || (DateTime.UtcNow - meterAt).TotalSeconds > 5) { meter = Open(); meterAt = DateTime.UtcNow; }
        float p = 0;
        try { if (meter == null || meter.GetPeakValue(out p) != 0) { p = 0; meter = null; } } catch { p = 0; meter = null; }
        if (float.IsNaN(p) || p < 0) p = 0;
        if (p > 1) p = 1;
        Emit("{\"l\":" + p.ToString("0.000", CultureInfo.InvariantCulture) + "}");
        Thread.Sleep(Math.Max(10, 1000 / hz));
      }
    }

    static void InputLoop() {
      string line;
      try {
        while ((line = Console.In.ReadLine()) != null) {
          line = line.Trim();
          if (line == "quit") break;
          if (line.StartsWith("rate ")) {
            int n;
            Hz = int.TryParse(line.Substring(5), out n) && n == 30 ? 30 : 0;
          } else if (line.StartsWith("ignore")) {
            string rest = line.Length > 7 ? line.Substring(7) : "";
            Ignore = rest.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
          }
        }
      } catch { }
      Environment.Exit(0);
    }

    public static bool Ignored(string app) {
      if (string.IsNullOrEmpty(app)) return false;
      string a = app.ToLowerInvariant();
      foreach (string i in Ignore) if (i.Length > 1 && a.Contains(i)) return true;
      return false;
    }

    public static void Start() {
      var m = new Thread(MeterLoop); m.IsBackground = true; m.Start();
      var r = new Thread(InputLoop); r.IsBackground = true; r.Start();
    }
  }
}
'@

[HelperAudio.Watch]::Start()

# Now playing (GSMTC), through PowerShell 5.1's WinRT projection, as say.ps1 does for speech.
$mgr = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $op = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
  $t = $asTask.MakeGenericMethod([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]).Invoke($null, @($op))
  if ($t.Wait(5000)) { $mgr = $t.Result }
} catch { $mgr = $null }

$last = -1
while ($true) {
  $now = 0
  if ($mgr) {
    try {
      foreach ($s in $mgr.GetSessions()) {
        # The playback state and the app's id only. The id stays here, for the ignore list.
        $state = "$($s.GetPlaybackInfo().PlaybackStatus)"
        if ($state -eq 'Playing' -and -not [HelperAudio.Watch]::Ignored($s.SourceAppUserModelId)) { $now = 1; break }
      }
    } catch { $now = 0 }
  }
  if ($now -ne $last) { [HelperAudio.Watch]::Emit('{"p":' + $now + '}'); $last = $now }
  Start-Sleep -Milliseconds 1000
}
