# Nus Companion Windows probe: one long-lived PowerShell sidecar that tells the
# overlay what is on screen without screenshots, native modules, or global
# hooks. JSON lines in on stdin, JSON lines out on stdout.
#
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"fg"}                                  foreground window
#   {"id":3,"op":"uia.list","hwnd":123,"max":150}       interactive controls
#   {"id":4,"op":"uia.frompoint","x":100,"y":200}       control under a point
#   {"id":5,"op":"uia.find","hwnd":123,"name":"Add a Game","type":"Button"}
#   {"id":6,"op":"watch.start","keys":[27],"click":true,"fg":true}
#   {"id":7,"op":"watch.stop"}
#
# Unsolicited events while watching:
#   {"ev":"click","x":..,"y":..}     left button released (physical px)
#   {"ev":"key","vk":27,"down":true}  a watched key changed
#   {"ev":"fg",...}                    the foreground window changed
#
# All coordinates are physical screen pixels (the process is per-monitor DPI
# aware); the Electron side converts with screen.screenToDipPoint.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NusWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern long GetWindowLongPtrW(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  public static string Title(IntPtr h) { var sb = new StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static int[] Cursor() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static int[] Rect(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) return null; return new int[] { r.L, r.T, r.R, r.B }; }
  public static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  // WS_EX_TRANSPARENT: the window never receives mouse input, so it is never
  // "the window under the cursor" nor "the app in front" (another Companion
  // instance, Discord/GeForce style overlays; measured 2026-09-10 with the
  // installed Nus 0.2.3 running beside the dev tree).
  public static bool ClickThrough(IntPtr h) { return ((long)GetWindowLongPtrW(h, -20) & 0x20) != 0; }
  // Top-level window under a point, skipping windows owned by `ignorePid`
  // (the Companion's own transparent overlay covers the whole work area).
  public static IntPtr TopWindowAt(int x, int y, uint ignorePid) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return h;
    h = GetAncestor(h, 2);
    int guard = 0;
    while (h != IntPtr.Zero && guard++ < 512) {
      if (IsWindowVisible(h) && Pid(h) != ignorePid && !ClickThrough(h)) {
        RECT r;
        if (GetWindowRect(h, out r) && x >= r.L && x < r.R && y >= r.T && y < r.B) return h;
      }
      h = GetWindow(h, 2);
    }
    return IntPtr.Zero;
  }
}
"@

try { [void][NusWin]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { try { [void][NusWin]::SetProcessDPIAware() } catch {} }

Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.Add($AE::NameProperty)
$cache.Add($AE::ControlTypeProperty)
$cache.Add($AE::AutomationIdProperty)
$cache.Add($AE::BoundingRectangleProperty)
$cache.Add($AE::IsOffscreenProperty)
$cache.Add($AE::ProcessIdProperty)
$cache.Add($AE::IsPasswordProperty)
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element

# Controls a person can act on. Containers are descended, not reported.
$Interactive = @{
  'Button'=1; 'MenuItem'=1; 'TabItem'=1; 'Hyperlink'=1; 'Edit'=1; 'ComboBox'=1;
  'CheckBox'=1; 'RadioButton'=1; 'ListItem'=1; 'TreeItem'=1; 'Slider'=1;
  'SplitButton'=1; 'Spinner'=1; 'MenuBar'=0; 'Menu'=0
}

function Out-Line($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Type-Name($el, $cached) {
  try {
    $ct = if ($cached) { $el.Cached.ControlType } else { $el.Current.ControlType }
    $n = $ct.ProgrammaticName
    if (-not $n) { return '' }   # File Explorer exposes elements with a null programmatic name; a null key aborted the whole walk
    if ($n -like 'ControlType.*') { return $n.Substring(12) }
    return $n
  } catch { return '' }
}

function Rect-Of($el, $cached) {
  try {
    $r = if ($cached) { $el.Cached.BoundingRectangle } else { $el.Current.BoundingRectangle }
    if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { return $null }
    if ([double]::IsInfinity($r.X) -or [double]::IsInfinity($r.Y)) { return $null }
    return @{ x=[int][math]::Round($r.X); y=[int][math]::Round($r.Y); w=[int][math]::Round($r.Width); h=[int][math]::Round($r.Height) }
  } catch { return $null }
}

function Describe($el, $cached, $id) {
  $props = if ($cached) { $el.Cached } else { $el.Current }
  $name = ''; $auto = ''; $procId = 0
  try { $name = [string]$props.Name } catch {}
  try { $auto = [string]$props.AutomationId } catch {}
  try { $procId = [int]$props.ProcessId } catch {}
  $password = $false
  try { $password = [bool]$props.IsPassword } catch { $password = $true }
  return @{ id=$id; name=$name; type=(Type-Name $el $cached); automationId=$auto; rect=(Rect-Of $el $cached); pid=$procId; isPassword=$password }
}

# The window the user is working in. When our own window (the overlay the
# user just clicked to type, or the Nus dashboard) is in front, walk down
# the z-order to the first visible, titled window that is not ours.
function Get-Foreground($ignore) {
  $h = [NusWin]::GetForegroundWindow()
  $skipped = $false
  if ($ignore -and $h -ne [IntPtr]::Zero -and [NusWin]::Pid($h) -eq [uint32]$ignore) {
    $skipped = $true
    $n = [NusWin]::GetWindow($h, 2); $guard = 0
    while ($n -ne [IntPtr]::Zero -and $guard++ -lt 512) {
      if ([NusWin]::IsWindowVisible($n) -and [NusWin]::Pid($n) -ne [uint32]$ignore -and -not [NusWin]::ClickThrough($n)) {
        $t = [NusWin]::Title($n)
        $rr = [NusWin]::Rect($n)
        if ($t -and $t -ne 'Program Manager' -and $rr -and ($rr[2] - $rr[0]) -gt 120 -and ($rr[3] - $rr[1]) -gt 80) { $h = $n; break }
      }
      $n = [NusWin]::GetWindow($n, 2)
    }
    if ($n -eq [IntPtr]::Zero -or $guard -ge 512) { $h = [IntPtr]::Zero }
  }
  if ($h -eq [IntPtr]::Zero) { return @{ hwnd=0; title=''; process=''; exe=''; pid=0; rect=$null; behindSelf=$skipped } }
  $procId = [NusWin]::Pid($h)
  $proc = ''; $exe = ''
  try { $p = Get-Process -Id $procId -ErrorAction Stop; $proc = $p.ProcessName; try { $exe = $p.Path } catch {} } catch {}
  $r = [NusWin]::Rect($h)
  $rect = $null
  if ($r) { $rect = @{ x=$r[0]; y=$r[1]; w=($r[2]-$r[0]); h=($r[3]-$r[1]) } }
  return @{ hwnd=[int64]$h; title=[NusWin]::Title($h); process=$proc; exe=$exe; pid=[int]$procId; rect=$rect; behindSelf=$skipped }
}

# Depth-first walk of the control view under a window, bounded by count, depth
# and time. Returns interactive, on-screen elements in document order.
function Walk-Controls($hwnd, $max, $budgetMs) {
  $root = $AE::FromHandle([IntPtr][int64]$hwnd)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $out = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $truncated = $false
  $first = $null
  try { $first = $walker.GetFirstChild($root, $cache) } catch { $first = $null }
  if ($first) { $stack.Push(@($first, 1)) }
  $seen = 0
  while ($stack.Count -gt 0) {
    if ($out.Count -ge $max -or $sw.ElapsedMilliseconds -gt $budgetMs) { $truncated = $true; break }
    $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]
    $seen++
    $sib = $null
    try { $sib = $walker.GetNextSibling($el, $cache) } catch { $sib = $null }
    if ($sib) { $stack.Push(@($sib, $depth)) }
    $off = $false
    try { $off = [bool]$el.Cached.IsOffscreen } catch {}
    $type = Type-Name $el $true
    if (-not $off -and $Interactive.ContainsKey($type) -and $Interactive[$type] -eq 1) {
      $d = Describe $el $true ($out.Count + 1)
      if ($d.rect) { [void]$out.Add($d) }
    }
    if ($depth -lt 18 -and -not $off) {
      $child = $null
      try { $child = $walker.GetFirstChild($el, $cache) } catch { $child = $null }
      if ($child) { $stack.Push(@($child, $depth + 1)) }
    }
  }
  return @{ elements=@($out.ToArray()); truncated=$truncated; visited=$seen; ms=[int]$sw.ElapsedMilliseconds }
}

function Score-Name($candidate, $want) {
  if (-not $candidate) { return 0 }
  $c = $candidate.Trim().ToLowerInvariant(); $w = $want.Trim().ToLowerInvariant()
  if ($c -eq $w) { return 100 }
  if ($c.StartsWith($w)) { return 80 }
  if ($c.Contains($w)) { return 60 }
  if ($w.Contains($c) -and $c.Length -ge 3) { return 40 }
  return 0
}

function Handle($req) {
  $op = [string]$req.op
  switch ($op) {
    'ping' { return @{ ok=$true; pid=$PID; ps=$PSVersionTable.PSVersion.ToString() } }
    'fg' { $ig = if ($req.ignorePid) { [uint32]$req.ignorePid } else { 0 }; return Get-Foreground $ig }
    'cursor' { $c = [NusWin]::Cursor(); return @{ x=$c[0]; y=$c[1] } }
    'win.topmost' {
      # Put a window back above everything without activating it. Chromium refuses
      # HWND_TOPMOST from inside the app while a monitor-sized window is up (measured
      # 2026-09-10); an external SetWindowPos from this process is honoured.
      $h = [IntPtr][int64]$req.hwnd
      $ok = [NusWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, [uint32](0x0001 -bor 0x0002 -bor 0x0010))
      $ex = [NusWin]::GetWindowLongPtrW($h, -20)
      return @{ ok=[bool]$ok; topmost=(($ex -band 8) -ne 0) }
    }
    'uia.list' {
      $max = if ($req.max) { [int]$req.max } else { 150 }
      $budget = if ($req.budgetMs) { [int]$req.budgetMs } else { 1200 }
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][NusWin]::GetForegroundWindow() }
      $r = Walk-Controls $hwnd $max $budget
      $r.hwnd = $hwnd
      return $r
    }
    'uia.frompoint' {
      $x = [int][double]$req.x; $y = [int][double]$req.y
      $ignore = if ($req.ignorePid) { [uint32]$req.ignorePid } else { [uint32]0 }
      # The window under the point, never our own overlay. Then the smallest
      # interactive control in that window containing the point: a text run
      # or image inside a button is not the control, the button is.
      $h = [NusWin]::TopWindowAt($x, $y, $ignore)
      if ($h -eq [IntPtr]::Zero) { return @{ element=$null; hwnd=0 } }
      $budget = if ($req.budgetMs) { [int]$req.budgetMs } else { 900 }
      $r = Walk-Controls ([int64]$h) 400 $budget
      $best = $null; $bestArea = [double]::MaxValue
      foreach ($e in $r.elements) {
        $rc = $e.rect
        if ($rc -and $x -ge $rc.x -and $x -lt ($rc.x + $rc.w) -and $y -ge $rc.y -and $y -lt ($rc.y + $rc.h)) {
          $area = [double]$rc.w * [double]$rc.h
          if ($area -lt $bestArea) { $best = $e; $bestArea = $area }
        }
      }
      $wr = [NusWin]::Rect($h)
      $winArea = if ($wr) { [double]($wr[2] - $wr[0]) * [double]($wr[3] - $wr[1]) } else { 0 }
      if (-not $best -or ($winArea -gt 0 -and $bestArea -gt 0.25 * $winArea)) {
        # Nothing interactive contains the point, or the only one is most of
        # the window (a chat message list, a document body; measured 2026-09-10
        # in ChatGPT: "Chat messages"): fall back to UIA's own hit test, the
        # deepest element under the point, as long as it is smaller and not
        # our overlay.
        try {
          $pt = New-Object System.Windows.Point ([double]$x), ([double]$y)
          $el = $AE::FromPoint($pt)
          if ($el) { $d = Describe $el $false 0; if ($d.pid -ne $ignore -and $d.rect -and (-not $best -or ([double]$d.rect.w * [double]$d.rect.h) -lt $bestArea)) { $best = $d; $best.fallback = $true } }
        } catch {}
      }
      return @{ element=$best; hwnd=[int64]$h; window=@{ title=[NusWin]::Title($h); pid=[int][NusWin]::Pid($h) }; searched=$r.elements.Count; truncated=$r.truncated; ms=$r.ms }
    }
    'uia.find' {
      $hwnd = if ($req.hwnd) { [int64]$req.hwnd } else { [int64][NusWin]::GetForegroundWindow() }
      $want = [string]$req.name
      $type = [string]$req.type
      $r = Walk-Controls $hwnd 400 1500
      $best = $null; $bestScore = 0
      foreach ($e in $r.elements) {
        $s = Score-Name $e.name $want
        if ($s -gt 0 -and $type -and $e.type -eq $type) { $s += 15 }
        if ($s -gt $bestScore) { $best = $e; $bestScore = $s }
      }
      return @{ element=$best; score=$bestScore; searched=$r.elements.Count; truncated=$r.truncated }
    }
    'watch.start' {
      $script:watch = @{
        keys = @(); click = [bool]$req.click; fg = [bool]$req.fg;
        prevKeys = @{}; prevClick = $false; downAt = $null; lastFg = 0; lastFgAt = 0
      }
      if ($req.keys) { $script:watch.keys = @($req.keys | ForEach-Object { [int]$_ }) }
      foreach ($k in $script:watch.keys) { $script:watch.prevKeys[$k] = [NusWin]::Down($k) }
      $script:watch.prevClick = [NusWin]::Down(1)
      $script:watch.lastFg = [int64][NusWin]::GetForegroundWindow()
      return @{ ok=$true; watching=$true }
    }
    'watch.stop' { $script:watch = $null; return @{ ok=$true; watching=$false } }
    default { return @{ error=('unknown op ' + $op) } }
  }
}

function Poll-Watch() {
  $w = $script:watch
  if (-not $w) { return }
  if ($w.click) {
    $down = [NusWin]::Down(1)
    if ($down -and -not $w.prevClick) { $w.downAt = [NusWin]::Cursor() }
    if (-not $down -and $w.prevClick) {
      $c = if ($w.downAt) { $w.downAt } else { [NusWin]::Cursor() }
      Out-Line @{ ev='click'; x=$c[0]; y=$c[1]; t=[int64][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
      $w.downAt = $null
    }
    $w.prevClick = $down
  }
  foreach ($k in $w.keys) {
    $d = [NusWin]::Down($k)
    if ($d -ne $w.prevKeys[$k]) { $w.prevKeys[$k] = $d; Out-Line @{ ev='key'; vk=$k; down=$d } }
  }
  if ($w.fg) {
    $now = [Environment]::TickCount
    if ($now - $w.lastFgAt -ge 500) {
      $w.lastFgAt = $now
      $h = [int64][NusWin]::GetForegroundWindow()
      if ($h -ne $w.lastFg) {
        $w.lastFg = $h
        $f = Get-Foreground 0; $f.ev = 'fg'
        Out-Line $f
      }
    }
  }
}

$script:watch = $null
$stdin = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
Out-Line @{ ev='ready'; pid=$PID }
$task = $reader.ReadLineAsync()
while ($true) {
  if ($task.IsCompleted) {
    $line = $task.Result
    if ($null -eq $line) { break }
    if ($line.Trim().Length -gt 0) {
      $id = $null
      try {
        $req = ConvertFrom-Json -InputObject $line
        $id = $req.id
        $res = Handle $req
        $res.id = $id
        Out-Line $res
      } catch {
        Out-Line @{ id=$id; error=[string]$_.Exception.Message }
      }
    }
    $task = $reader.ReadLineAsync()
  }
  if ($script:watch) {
    try { Poll-Watch } catch { Out-Line @{ ev='error'; message=[string]$_.Exception.Message } }
    Start-Sleep -Milliseconds 16
  } else {
    [void]$task.Wait(200)
  }
}
