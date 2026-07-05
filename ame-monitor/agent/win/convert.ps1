param([string]$inPath, [string]$outPath)
# Convert AME's TIFF preview to JPEG so browsers can display it (Windows has no `sips`).
try {
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($inPath)
    $img.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $img.Dispose()
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
