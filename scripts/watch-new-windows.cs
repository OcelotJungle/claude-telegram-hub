using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// The engine of watch-new-windows.ps1. Windows come from a WinEvent hook
// (EVENT_OBJECT_SHOW), so even a window that lives a few milliseconds is caught.
// Processes come from a Toolhelp snapshot taken every few milliseconds; their
// command lines are looked up on a side thread (best effort: a short-lived
// process may be gone by then).
public static class WatchWin {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc proc, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const uint WINEVENT_SKIPOWNPROCESS = 2;
  const uint GA_ROOT = 2;
  const uint PM_REMOVE = 1;
  const uint TH32CS_SNAPPROCESS = 2;

  static readonly object logLock = new object();
  static string outPath;
  static readonly Dictionary<uint, string> names = new Dictionary<uint, string>();
  static readonly BlockingCollection<string> lookups = new BlockingCollection<string>();
  static WinEventProc keepAlive;

  static string Now() { return DateTime.UtcNow.ToString("HH:mm:ss.fff"); }
  static void Log(string line) {
    lock (logLock) {
      if (outPath == null) Console.WriteLine(line); else File.AppendAllText(outPath, line + Environment.NewLine);
    }
  }
  static string Name(uint pid) { string n; lock (names) { return names.TryGetValue(pid, out n) ? n : ""; } }

  static void OnShow(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != 0 || hwnd == IntPtr.Zero || GetAncestor(hwnd, GA_ROOT) != hwnd) return;
    uint pid; GetWindowThreadProcessId(hwnd, out pid);
    var c = new StringBuilder(256); GetClassName(hwnd, c, 256);
    var t = new StringBuilder(256); GetWindowText(hwnd, t, 256);
    Log("WINDOW " + Now() + " class=" + c + " title=" + t + " pid=" + pid + " exe=" + Name(pid));
  }

  static void Snapshot(bool log) {
    IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return;
    var e = new PROCESSENTRY32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
    if (Process32FirstW(snap, ref e)) {
      do {
        string old;
        bool known;
        lock (names) { known = names.TryGetValue(e.th32ProcessID, out old) && old == e.szExeFile; if (!known) names[e.th32ProcessID] = e.szExeFile; }
        if (!known && log) lookups.Add(Now() + "|" + e.th32ProcessID + "|" + e.th32ParentProcessID + "|" + e.szExeFile);
      } while (Process32NextW(snap, ref e));
    }
    CloseHandle(snap);
  }

  static void LookupLoop() {
    foreach (var item in lookups.GetConsumingEnumerable()) {
      var p = item.Split('|');
      string cmd = "";
      try {
        using (var s = new ManagementObjectSearcher("SELECT CommandLine FROM Win32_Process WHERE ProcessId=" + p[1]))
          foreach (ManagementObject o in s.Get()) cmd = Convert.ToString(o["CommandLine"]);
      } catch { }
      Log("proc " + p[0] + " pid=" + p[1] + " ppid=" + p[2] + " parent=" + Name(uint.Parse(p[2])) + " exe=" + p[3] + " cmd=" + cmd.Replace("\r", " ").Replace("\n", " "));
    }
  }

  public static void Run(int seconds, string output, string stopFile) {
    outPath = string.IsNullOrEmpty(output) ? null : output;
    Snapshot(false);
    var lookupThread = new Thread(LookupLoop); lookupThread.IsBackground = true; lookupThread.Start();
    keepAlive = OnShow;
    IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, keepAlive, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
    Log("start " + Now());
    var end = DateTime.UtcNow.AddSeconds(seconds);
    while (DateTime.UtcNow < end && (string.IsNullOrEmpty(stopFile) || !File.Exists(stopFile))) {
      MSG m;
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, PM_REMOVE)) { TranslateMessage(ref m); DispatchMessage(ref m); }
      Snapshot(true);
      Thread.Sleep(5);
    }
    UnhookWinEvent(hook);
    lookups.CompleteAdding();
    lookupThread.Join(5000);
    Log("end " + Now());
  }
}
