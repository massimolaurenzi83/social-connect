# Social Connect — server statico di sviluppo (nessuna dipendenza)
# Uso: powershell -ExecutionPolicy Bypass -File tools/serve.ps1 [-Port 8090]
param([int]$Port = 8090)

$root = Split-Path -Parent $PSScriptRoot
$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
    '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'
    '.webmanifest' = 'application/manifest+json'; '.ico' = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Social Connect in ascolto su http://localhost:$Port/ (CTRL+C per fermare)"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrEmpty($path)) { $path = 'index.html' }
    $file = Join-Path $root $path
    try {
        if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith((Resolve-Path $root).Path))) {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ext = [System.IO.Path]::GetExtension($file).ToLower()
            $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
            $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
        }
    } catch { $ctx.Response.StatusCode = 500 }
    $ctx.Response.Close()
}
