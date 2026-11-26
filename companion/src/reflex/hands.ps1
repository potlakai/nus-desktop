# Nus reflex hands: the only process in the Companion that presses keys.
# Kept apart from win/probe.ps1 on purpose: the probe's promise is that it only
# ever reads the screen, and that promise is tested. This sidecar is started
# only when the reflex layer is on (TYPESAFE_API_KEY set).
#
# Same wire format as the probe: JSON lines in on stdin, JSON lines out.
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"keys.chord","keys":[17,84]}          press in order, release in reverse (Ctrl+T)
#   {"id":3,"op":"keys.text","text":"hello","enter":false}
#   {"id":4,"op":"keys.slow","hwnd":123,"text":"Hi","delayMs":55,"requireEmpty":true}
#        typed live, one character at a time, ONLY while window 123 is in front and the person is
#        not pressing a key or a mouse button; it stops at once otherwise (the first-run hello).
#
# keys.text refuses to type into a password field, and mouse.click refuses to
# click into one. Since Hands (0.1.5) the mouse ops exist too: mouse.click,
# mouse.move, mouse.scroll, mouse.drag, and keys.press for a wider key list.
# Nothing here reads anything back beyond ok/refused, except keys.copy: the
# words a Ctrl+C copied, for rewriting a selection UI Automation cannot read.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NusHands {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  public static string Title(IntPtr h) { var sb = new System.Text.StringBuilder(1024); GetWindowTextW(h, sb, 1024); return sb.ToString(); }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static uint FgPid() { uint p = 0; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
  // Windows only lets a process take the foreground if it just received input.
  // A tap of Alt is that input; it is the documented way round the focus lock.
  public static bool Activate(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  // A key or a mouse button held down by the person right now. Enter is left out (the live typing
  // sends it and lets go before the next look) and so is VK_PACKET (the typed characters).
  public static bool PersonActive() {
    int[] mouse = { 0x01, 0x02, 0x04, 0x05, 0x06 };
    foreach (int b in mouse) if ((GetAsyncKeyState(b) & 0x8000) != 0) return true;
    for (int vk = 0x08; vk <= 0xFE; vk++) {
      if (vk == 0x0D || vk == 0xE7) continue;
      if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true;
    }
    return false;
  }
  // One character as real key events: Enter for a line break, else a Unicode key.
  public static void OneChar(char c) {
    if (c == '\r') return;
    if (c == '\n') Send(Key(0x0D, 0, 0), Key(0x0D, 0, KEYUP));
    else Send(Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP));
  }
  public static void Chord(int[] vks) {
    foreach (int v in vks) keybd_event((byte)v, 0, 0, UIntPtr.Zero);
    for (int i = vks.Length - 1; i >= 0; i--) keybd_event((byte)vks[i], 0, 2, UIntPtr.Zero);
  }
  // The mouse, for Hands: real input through SendInput, in physical screen
  // pixels (the probe's coordinates), so a click lands where the thread pointed.
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  // INPUT is a union in Win32: the mouse and keyboard records share the space,
  // so one struct size serves both and SendInput accepts either kind.
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  const uint MOVE = 0x0001, ABS = 0x8000, VDESK = 0x4000, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x1000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;
  static INPUT Mouse(uint flags, int dx, int dy, uint data) { var i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
  // Text as one burst of Unicode key events (SendKeys.SendWait took ~10 s for
  // 160 characters live 2026-10-11; this takes milliseconds). Newlines and
  // tabs go as the Enter and Tab keys so every editor takes them. Returns how
  // many events Windows accepted; 0 means it refused and the caller falls back.
  public static int Text(string s) {
    var list = new System.Collections.Generic.List<INPUT>();
    int accepted = 0, size = Marshal.SizeOf(typeof(INPUT));
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { list.Add(Key(0x0D, 0, 0)); list.Add(Key(0x0D, 0, KEYUP)); }
      else if (c == '\t') { list.Add(Key(0x09, 0, 0)); list.Add(Key(0x09, 0, KEYUP)); }
      else { list.Add(Key(0, c, UNICODE)); list.Add(Key(0, c, UNICODE | KEYUP)); }
      if (list.Count >= 64) { accepted += (int)SendInput((uint)list.Count, list.ToArray(), size); list.Clear(); System.Threading.Thread.Sleep(5); }
    }
    if (list.Count > 0) accepted += (int)SendInput((uint)list.Count, list.ToArray(), size);
    return accepted;
  }
  // Absolute coordinates on the virtual desktop run 0..65535 across every monitor.
  static INPUT MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    int ax = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1)), ay = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    return Mouse(MOVE | ABS | VDESK, ax, ay, 0);
  }
  public static void Move(int x, int y) { Send(MoveTo(x, y)); }
  public static void Click(int x, int y, string button, bool twice) {
    uint down = LDOWN, up = LUP;
    if (button == "right") { down = RDOWN; up = RUP; } else if (button == "middle") { down = MDOWN; up = MUP; }
    Send(MoveTo(x, y));
    System.Threading.Thread.Sleep(30);
    Send(Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0));
    if (twice) { System.Threading.Thread.Sleep(60); Send(Mouse(down, 0, 0, 0), Mouse(up, 0, 0, 0)); }
  }
  public static void Scroll(int x, int y, int dy, int dx) {
    Send(MoveTo(x, y));
    System.Threading.Thread.Sleep(20);
    if (dy != 0) Send(Mouse(WHEEL, 0, 0, unchecked((uint)(dy * 120))));
    if (dx != 0) Send(Mouse(HWHEEL, 0, 0, unchecked((uint)(dx * 120))));
  }
  public static void Drag(int x0, int y0, int x1, int y1, int steps) {
    Send(MoveTo(x0, y0)); System.Threading.Thread.Sleep(40);
    Send(Mouse(LDOWN, 0, 0, 0)); System.Threading.Thread.Sleep(60);
    for (int i = 1; i <= steps; i++) { Send(MoveTo(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)); System.Threading.Thread.Sleep(16); }
    System.Threading.Thread.Sleep(60); Send(Mouse(LUP, 0, 0, 0));
  }
}
"@
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$AE = [System.Windows.Automation.AutomationElement]

# Keys this sidecar will press. Letters and digits are typed through keys.text;
# a chord may only combine modifiers with navigation, media and a few letters.
$AllowedVk = @(0x09,0x10,0x11,0x12,0x25,0x26,0x27,0x28,0x2C,0x4E,0x54,0x57,0x5B,0xAD,0xAE,0xAF,0xB3)
# Hands (keys.press): the same plus Enter, Escape, Space, Backspace, Delete,
# Home, End, Page Up/Down, F1-F12 and the letters, so Ctrl+S, Ctrl+Z, Ctrl+A,
# Ctrl+C, Ctrl+V and friends can be sent. Never the Windows key alone.
$PressVk = @(0x08,0x09,0x0D,0x10,0x11,0x12,0x1B,0x20,0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2E,0x2C,0x5B,0x70,0x71,0x72,0x73,0x74,0x75,0x76,0x77,0x78,0x79,0x7A,0x7B,0xAD,0xAE,0xAF,0xB3) + @(0x30..0x39) + @(0x41..0x5A) + @(0xBB,0xBD,0xBC,0xBE,0xBF,0xC0,0xDB,0xDC,0xDD,0xDE)

function Out-Line($obj) {
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 4))
  [Console]::Out.Flush()
}

# Hands keys must land in the app, never in the Companion's own windows. If
# the Companion holds the foreground (its overlay caught a click, a card had
# focus), the window Hands last read (`hwnd`) is brought back first. Returns
# where the keys will go, so the result can say so.
function Ensure-Target($req) {
  $self = [uint32]0
  if ($req.selfPid) { $self = [uint32]$req.selfPid }
  $refocused = $false
  # Keys go to the window Hands meant (`hwnd`), never to whatever happens to
  # be in front: an app it just opened may still be coming up, or the person
  # may have glanced at another window (live 2026-10-11: Ctrl+Enter meant for
  # Notepad landed in the chat window that was still in front).
  if ($req.hwnd) {
    $h = [IntPtr][int64]$req.hwnd
    if ([NusHands]::IsWindow($h) -and [NusHands]::GetForegroundWindow() -ne $h) {
      [void][NusHands]::Activate($h); Start-Sleep -Milliseconds 80; $refocused = $true
    }
  }
  $fg = [NusHands]::GetForegroundWindow()
  $name = ''; $type = ''
  try { $f = $AE::FocusedElement; if ($f) { $name = [string]$f.Current.Name; $type = [string]$f.Current.LocalizedControlType } } catch {}
  return @{ ours = ($self -ne 0 -and [NusHands]::FgPid() -eq $self); window = [NusHands]::Title($fg); focus = $name; focusType = $type; refocused = $refocused }
}

# What is on the clipboard (text, an image, or copied files), so it can be put
# back after a paste or a copy (a data object taken off the clipboard cannot
# be put back whole; its contents can).
function Save-Clip() {
  $CB = [System.Windows.Forms.Clipboard]
  $saved = @{ text=$null; image=$null; files=$null }
  try {
    if ($CB::ContainsText()) { $saved.text = $CB::GetText() }
    elseif ($CB::ContainsImage()) { $saved.image = $CB::GetImage() }
    elseif ($CB::ContainsFileDropList()) { $saved.files = $CB::GetFileDropList() }
  } catch {}
  return $saved
}
function Restore-Clip($saved) {
  $CB = [System.Windows.Forms.Clipboard]
  try {
    if ($null -ne $saved.text) { $CB::SetText($saved.text) }
    elseif ($null -ne $saved.image) { $CB::SetImage($saved.image) }
    elseif ($null -ne $saved.files) { $CB::SetFileDropList($saved.files) }
    else { $CB::Clear() }
  } catch {}
}

# The focused field's own text, read-only, for checking that a paste landed:
# its value (an edit box, a search box, a browser address bar) or its document
# text (Notepad, Word). Null when the field offers neither.
function Read-FocusedText() {
  try {
    $f = $AE::FocusedElement
    if (-not $f) { return $null }
    try { if ([bool]$f.Current.IsPassword) { return $null } } catch {}
    $vp = $null
    if ($f.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) { return [string]$vp.Current.Value }
    $tp = $null
    if ($f.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return [string]$tp.DocumentRange.GetText(6000) }
  } catch {}
  return $null
}
function Squash($s) { return ([regex]::Replace([string]$s, '\s+', ' ')).Trim() }
function Clip-Needle($s) { $q = Squash $s; if ($q.Length -gt 40) { $q = $q.Substring(0, 40) }; return $q }

function Handle($req) {
  switch ([string]$req.op) {
    'ping' { return @{ ok=$true; pid=$PID } }
    'keys.chord' {
      $vks = @($req.keys | ForEach-Object { [int]$_ })
      if ($vks.Count -lt 1 -or $vks.Count -gt 4) { return @{ ok=$false; error='1 to 4 keys' } }
      foreach ($v in $vks) { if ($AllowedVk -notcontains $v) { return @{ ok=$false; error=('key not allowed: ' + $v) } } }
      [NusHands]::Chord([int[]]$vks)
      return @{ ok=$true }
    }
    'win.activate' {
      # By handle, for the focus guard: the window the probe saw a moment ago.
      # Its title is read again HERE, right before activation, and must still
      # carry the feed word (`mustContain`), or nothing is activated and the
      # Ctrl+W that follows never goes anywhere. A feed tab that was switched
      # away from between the poll and the press is left alone.
      if ($req.hwnd) {
        $h = [IntPtr][int64]$req.hwnd
        if (-not [NusHands]::IsWindow($h)) { return @{ ok=$false; found=$false; error='no such window' } }
        $t = [NusHands]::Title($h)
        $must = [string]$req.mustContain
        if (-not $must -or $must.Trim().Length -lt 2) { return @{ ok=$false; found=$true; refused='no title check'; title=$t } }
        if (-not ([regex]::IsMatch($t, '(?i)(?:^|[^a-z0-9])' + [regex]::Escape($must.Trim()) + '(?![a-z0-9])'))) { return @{ ok=$false; found=$true; refused='title changed'; title=$t } }
        $front = [NusHands]::Activate($h)
        if ($front) { $t2 = [NusHands]::Title($h); if ($t2 -ne $t) { return @{ ok=$false; found=$true; refused='title changed'; title=$t2 } } }
        return @{ ok=[bool]$front; found=$true; title=$t; hwnd=[int64]$h }
      }
      # Bring an app that is ALREADY running to the front. Launching it again from
      # the background only flashes the taskbar (live 2026-09-21), so keys meant
      # for it would have gone to whatever was in front instead.
      $want = ([string]$req.name).ToLowerInvariant() -replace '[^a-z0-9]', ''
      if ($want.Length -lt 3) { return @{ ok=$false; error='name too short' } }
      $hit = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Id -ne $PID } | Where-Object {
        $p = $_.ProcessName.ToLowerInvariant() -replace '[^a-z0-9]', ''
        $t = ([string]$_.MainWindowTitle).ToLowerInvariant() -replace '[^a-z0-9]', ''
        ($p.Length -ge 3 -and ($want.Contains($p) -or $p.Contains($want))) -or $t.EndsWith($want)
      } | Sort-Object { [string]::IsNullOrEmpty([string]$_.MainWindowTitle) } | Select-Object -First 1
      # A window with a title first: Windows 11 runs extra Notepad processes whose main window is
      # hidden, and activating one of those brought nothing forward (walk 2026-11-11).
      if (-not $hit) { return @{ ok=$false; found=$false } }
      $front = [NusHands]::Activate([IntPtr]$hit.MainWindowHandle)
      return @{ ok=[bool]$front; found=$true; process=$hit.ProcessName; hwnd=[int64]$hit.MainWindowHandle }
    }
    # Hands: pointer operations, physical pixel coordinates. A click on a
    # secure text field is declined, the same way keys.text declines it.
    'mouse.click' {
      $x = [int]$req.x; $y = [int]$req.y
      $secure = $false
      try { $el = $AE::FromPoint((New-Object System.Windows.Point($x, $y))); if ($el) { $secure = [bool]$el.Current.IsPassword } } catch {}
      if ($secure) { return @{ ok=$false; refused='password' } }
      $button = [string]$req.button; if (-not $button) { $button = 'left' }
      [NusHands]::Click($x, $y, $button, [bool]$req.double)
      return @{ ok=$true; x=$x; y=$y; button=$button }
    }
    'mouse.move' { [NusHands]::Move([int]$req.x, [int]$req.y); return @{ ok=$true } }
    'mouse.scroll' {
      $dy = [int]$req.dy; $dx = [int]$req.dx
      if ([math]::Abs($dy) -gt 20 -or [math]::Abs($dx) -gt 20) { return @{ ok=$false; error='scroll too far' } }
      [NusHands]::Scroll([int]$req.x, [int]$req.y, $dy, $dx)
      return @{ ok=$true }
    }
    'mouse.drag' {
      [NusHands]::Drag([int]$req.x0, [int]$req.y0, [int]$req.x1, [int]$req.y1, 20)
      return @{ ok=$true }
    }
    'keys.press' {
      # One key or a chord from the wider Hands list (Enter, Escape, arrows,
      # Home, End, Page keys, Delete, function keys, Ctrl with a letter).
      $vks = @($req.keys | ForEach-Object { [int]$_ })
      if ($vks.Count -lt 1 -or $vks.Count -gt 4) { return @{ ok=$false; error='1 to 4 keys' } }
      foreach ($v in $vks) { if ($PressVk -notcontains $v) { return @{ ok=$false; error=('key not allowed: ' + $v) } } }
      $where = Ensure-Target $req
      if ($where.ours) { return @{ ok=$false; error='the keys would have gone to Nus itself'; window=$where.window } }
      [NusHands]::Chord([int[]]$vks)
      return @{ ok=$true; window=$where.window; focus=$where.focus; focusType=$where.focusType; refocused=$where.refocused }
    }
    'keys.text' {
      $where = Ensure-Target $req
      if ($where.ours) { return @{ ok=$false; error='the keys would have gone to Nus itself'; window=$where.window } }
      $secret = $false
      try { $f = $AE::FocusedElement; if ($f) { $secret = [bool]$f.Current.IsPassword } } catch {}
      if ($secret) { return @{ ok=$false; refused='password' } }
      $t = [string]$req.text
      # 1500 for a typed line; a rewrite of the selection may ask for more.
      $cap = 1500
      if ($req.max) { $cap = [math]::Max(1, [math]::Min(20000, [int]$req.max)) }
      if ($t.Length -gt $cap) { $t = $t.Substring(0, $cap) }
      # Text goes in as a paste: the words land on the clipboard, Ctrl+V puts
      # them in the field, and whatever was on the clipboard before is put back.
      # Every app takes a paste the same way. SendKeys typed at ~16 characters
      # a second (10 s for a list, live 2026-10-11), and a burst of Unicode key
      # events, fast in a plain text box, came out as "To-do:nnnnnn" in the new
      # Windows 11 Notepad. SendKeys stays as the fallback when the clipboard
      # cannot be used.
      $how = 'paste'
      if ($t.Length -gt 0) {
        $pasted = $false
        try {
          # What was on the clipboard: text, an image or copied files are put
          # back afterwards (a data object taken off the clipboard cannot be
          # put back whole; its contents can).
          $oldText = $null; $oldImage = $null; $oldFiles = $null
          $CB = [System.Windows.Forms.Clipboard]
          try {
            if ($CB::ContainsText()) { $oldText = $CB::GetText() }
            elseif ($CB::ContainsImage()) { $oldImage = $CB::GetImage() }
            elseif ($CB::ContainsFileDropList()) { $oldFiles = $CB::GetFileDropList() }
          } catch {}
          # What the box held before the paste: a read-back that changed but
          # does not show the needle means the paste landed somewhere the read
          # cannot see (past the first 6000 characters, say), not that it failed.
          $before = Read-FocusedText
          $CB::SetText($t, [System.Windows.Forms.TextDataFormat]::UnicodeText)
          Start-Sleep -Milliseconds 30
          [NusHands]::Chord([int[]]@(0x11, 0x56))
          # A browser reads the clipboard a moment after the key, so the old
          # clipboard goes back only once the field shows the words (live
          # 2026-10-13: YouTube's search box got an empty paste and Enter
          # searched for nothing). Read-only check through the field's own
          # value; a field that cannot be read is given the old fixed wait.
          $verified = $null
          $needle = Clip-Needle $t
          $deadline = [DateTime]::Now.AddMilliseconds(900)
          do {
            $v = Read-FocusedText
            if ($null -eq $v) { break }
            if ((Squash $v).Contains($needle)) { $verified = $true; break }
            $verified = $false
            Start-Sleep -Milliseconds 70
          } while ([DateTime]::Now -lt $deadline)
          if ($null -eq $verified) { Start-Sleep -Milliseconds (160 + [math]::Min(400, $t.Length / 4)) }
          if ($verified -eq $false -and $t -match "[\r\n]") {
            # SendKeys turns a line break into Enter (and Ctrl+Enter), keys the
            # caller never asked for (security validation 2026-11-01, L4): a
            # multi-line paste that cannot be confirmed is reported, not retyped.
            $how = 'none'
          } elseif ($verified -eq $false -and $null -ne $before -and $v -ne $before) {
            # The box changed, so the paste went in where the read cannot see it.
            $how = 'paste'
          } elseif ($verified -eq $false -and $req.retype -eq $false) {
            # Dictation (0.1.37) asks for no retype. Firefox reports its address
            # bar as the focused field while the caret is in a page's text box, so
            # the read cannot see a paste that did land, and typing it again put
            # every sentence in twice (tried 2026-11-23). The paste stands, unconfirmed.
            $how = 'paste'
          } elseif ($verified -eq $false) {
            # The paste did not land (a box that rejects paste): type it instead.
            $how = 'sendkeys'
            $esc = [regex]::Replace($t, '[+^%~(){}\[\]]', '{$0}')
            [System.Windows.Forms.SendKeys]::SendWait($esc)
            Start-Sleep -Milliseconds 120
            $v = Read-FocusedText
            if ($null -ne $v -and (Squash $v).Contains($needle)) { $verified = $true }
          }
          try {
            if ($null -ne $oldText) { $CB::SetText($oldText) }
            elseif ($null -ne $oldImage) { $CB::SetImage($oldImage) }
            elseif ($null -ne $oldFiles) { $CB::SetFileDropList($oldFiles) }
            else { $CB::Clear() }
          } catch {}
          $pasted = $true
        } catch { $pasted = $false }
        if (-not $pasted -and $t -match "[\r\n]") {
          # Same rule when the clipboard itself failed (L4): no Enter by accident.
          $how = 'none'; $verified = $false
        } elseif (-not $pasted) {
          $how = 'sendkeys'
          $esc = [regex]::Replace($t, '[+^%~(){}\[\]]', '{$0}')
          [System.Windows.Forms.SendKeys]::SendWait($esc)
        }
      }
      # Enter only once the words are in (or could not be checked); a box that
      # plainly does not hold them is not submitted empty.
      if ($req.enter -and $verified -ne $false) { Start-Sleep -Milliseconds 80; [NusHands]::Chord([int[]]@(0x0D)) }
      return @{ ok=$true; chars=$t.Length; how=$how; verified=$verified; submitted=[bool]($req.enter -and $verified -ne $false); window=$where.window; focus=$where.focus; focusType=$where.focusType; refocused=$where.refocused }
    }
    'keys.slow' {
      # The first-run hello (companion/src/hello.js): words typed live into the one window the
      # Companion opened itself. It never brings a window forward: if that window is not in front,
      # if it is gone, or if the person presses a key or a mouse button, it stops at once and says
      # how far it got. requireEmpty: nothing is typed unless the document is empty (a restored
      # Notepad tab holds the person's own text).
      $h = [IntPtr][int64]$req.hwnd
      if (-not $req.hwnd -or -not [NusHands]::IsWindow($h)) { return @{ ok=$false; stopped='gone'; typed=0 } }
      if ([NusHands]::GetForegroundWindow() -ne $h) { return @{ ok=$false; stopped='focus'; typed=0 } }
      try { $f = $AE::FocusedElement; if ($f -and [bool]$f.Current.IsPassword) { return @{ ok=$false; refused='password'; typed=0 } } } catch {}
      $empty = $null
      if ($req.requireEmpty) {
        $v = Read-FocusedText
        if ($null -ne $v) { $empty = ((Squash $v).Length -eq 0) }
        if ($empty -eq $false) { return @{ ok=$false; stopped='not_empty'; typed=0; empty=$false } }
      }
      $t = [string]$req.text
      if ($t.Length -gt 400) { $t = $t.Substring(0, 400) }
      $delay = 55
      if ($req.delayMs) { $delay = [math]::Max(15, [math]::Min(200, [int]$req.delayMs)) }
      $n = 0
      foreach ($c in $t.ToCharArray()) {
        if (-not [NusHands]::IsWindow($h)) { return @{ ok=$false; stopped='gone'; typed=$n; empty=$empty } }
        if ([NusHands]::GetForegroundWindow() -ne $h) { return @{ ok=$false; stopped='focus'; typed=$n; empty=$empty } }
        if ([NusHands]::PersonActive()) { return @{ ok=$false; stopped='person'; typed=$n; empty=$empty } }
        [NusHands]::OneChar($c)
        $n++
        Start-Sleep -Milliseconds $delay
      }
      return @{ ok=$true; typed=$n; empty=$empty; window=[NusHands]::Title($h) }
    }
    'keys.copy' {
      # "Make this friendlier" in an app whose selection UI Automation cannot
      # read (Google Docs draws its own text): Ctrl+C to the target window,
      # the copied words back, and the clipboard put back as it was. Never in
      # a password field.
      $where = Ensure-Target $req
      if ($where.ours) { return @{ ok=$false; error='the keys would have gone to Nus itself'; window=$where.window } }
      $secret = $false
      try { $f = $AE::FocusedElement; if ($f) { $secret = [bool]$f.Current.IsPassword } } catch {}
      if ($secret) { return @{ ok=$false; refused='password' } }
      $CB = [System.Windows.Forms.Clipboard]
      $saved = Save-Clip
      $got = ''
      try {
        $CB::Clear()
        Start-Sleep -Milliseconds 30
        [NusHands]::Chord([int[]]@(0x11, 0x43))
        for ($i = 0; $i -lt 12; $i++) { Start-Sleep -Milliseconds 50; if ($CB::ContainsText()) { break } }
        if ($CB::ContainsText()) { $got = [string]$CB::GetText() }
      } catch { $got = '' }
      Restore-Clip $saved
      $cap = 20000
      if ($req.max) { $cap = [math]::Max(1, [math]::Min(20000, [int]$req.max)) }
      if ($got.Length -gt $cap) { $got = $got.Substring(0, $cap) }
      return @{ ok=$true; text=$got; window=$where.window; focusType=$where.focusType; refocused=$where.refocused }
    }
    default { return @{ error=('unknown op ' + [string]$req.op) } }
  }
}

$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
Out-Line @{ ev='ready'; pid=$PID }
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
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
