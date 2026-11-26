# Reads the words off one image with the OCR engine built into Windows
# (Windows.Media.Ocr). Local, free, about half a second once loaded. Used by
# assignment mode to tell "the same problem, scrolled" from "a new problem"
# before a model call is spent. Windows PowerShell 5.1 only: pwsh 7 cannot load
# WinRT types this way.
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path <image>
# stdout: the text, UTF-8. Exit 2 when no OCR language is installed.
# -Words: instead, the image size on the first row ("W H"), then one word per
# row "x y w h word" in image pixels with a blank row between lines
# (src/guide/marks.js draws on the screen from these).
param([Parameter(Mandatory = $true)][string]$Path, [switch]$Words)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine  = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { [Console]::Error.WriteLine('no OCR language installed'); exit 2 }
$result  = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
if ($Words) {
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append([int]$bitmap.PixelWidth).Append(' ').Append([int]$bitmap.PixelHeight).Append([char]10)
  foreach ($line in $result.Lines) {
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $word = ([string]$w.Text) -replace '\s+', ' '
      [void]$sb.Append(([double]$r.X).ToString('0.#', $inv)).Append(' ').Append(([double]$r.Y).ToString('0.#', $inv)).Append(' ').Append(([double]$r.Width).ToString('0.#', $inv)).Append(' ').Append(([double]$r.Height).ToString('0.#', $inv)).Append(' ').Append($word).Append([char]10)
    }
    [void]$sb.Append([char]10)
  }
  [Console]::Out.Write($sb.ToString())
} else {
  [Console]::Out.Write($result.Text)
}
$stream.Dispose()
