# Social Connect — aggregatore feed
# Legge data/catalog.json, scarica i contenuti dalle fonti (RSS, YouTube, Reddit)
# e genera data/feeds/<categoria>.json. Le fonti "live" (Bluesky, Mastodon)
# vengono lette direttamente dal browser e qui saltate.
# Uso: powershell -ExecutionPolicy Bypass -File tools/aggregate.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$catalog = Get-Content (Join-Path $root 'data/catalog.json') -Raw | ConvertFrom-Json
$outDir = Join-Path $root 'data/feeds'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
$maxPerSource = 12
$maxPerCategory = 48

# Cache degli ID canale YouTube risolti (evita di riscaricare la pagina del canale a ogni run)
$channelCacheFile = Join-Path $root 'data/channels.json'
$channelCache = @{}
if (Test-Path $channelCacheFile) {
    (Get-Content $channelCacheFile -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $channelCache[$_.Name] = $_.Value }
}

# Sessione con cookie di consenso EU per YouTube (senza, viene servita la pagina di consenso)
$ytSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$ytSession.Cookies.Add((New-Object System.Net.Cookie('SOCS', 'CAI', '/', '.youtube.com')))

function Get-Url([string]$url, $session) {
    $params = @{ Uri = $url; UserAgent = $UA; TimeoutSec = 25; MaximumRedirection = 5 }
    if ($session) { $params.WebSession = $session }
    (Invoke-WebRequest @params).Content
}

function Strip-Html([string]$html) {
    if (-not $html) { return '' }
    $t = $html -replace '<[^>]+>', ' '
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    $t = ($t -replace '\s+', ' ').Trim()
    if ($t.Length -gt 220) { $t = $t.Substring(0, 217) + '...' }
    return $t
}

function Parse-Date($value) {
    if (-not $value) { return (Get-Date).ToUniversalTime() }
    try { return ([datetime]::Parse($value, [System.Globalization.CultureInfo]::InvariantCulture)).ToUniversalTime() }
    catch {
        try { return ([datetime]::Parse($value)).ToUniversalTime() } catch { return (Get-Date).ToUniversalTime() }
    }
}

# ID stabile e ripetibile: GetHashCode() cambia a ogni processo in .NET Core,
# quindi gli id degli articoli cambiavano a ogni run (falsi "nuovi contenuti"
# e commit inutili). Con MD5 dell'URL l'id resta sempre lo stesso.
function Get-StableId([string]$text) {
    $md5 = [System.Security.Cryptography.MD5]::Create()
    $bytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text))
    $md5.Dispose()
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 12).ToLower()
}

function First-ImageFromHtml([string]$html) {
    if (-not $html) { return $null }
    if ($html -match '<img[^>]+src="(http[^"]+)"') { return $Matches[1] }
    return $null
}

function Parse-Rss([xml]$xml, $source) {
    $items = @()
    $nodes = $null
    if ($xml.rss) { $nodes = $xml.rss.channel.item }
    elseif ($xml.feed) { $nodes = $xml.feed.entry }   # Atom
    if (-not $nodes) { return $items }
    foreach ($n in ($nodes | Select-Object -First $maxPerSource)) {
        $title = if ($n.title -is [System.Xml.XmlElement]) { $n.title.InnerText } else { [string]$n.title }
        $link = $null
        if ($n.link -is [System.Array]) {
            $alt = $n.link | Where-Object { $_.rel -eq 'alternate' -or -not $_.rel } | Select-Object -First 1
            if ($alt) { $link = $alt.href }
        } elseif ($n.link -is [System.Xml.XmlElement]) {
            $link = if ($n.link.href) { $n.link.href } else { $n.link.InnerText }
        } else { $link = [string]$n.link }
        if (-not $title -or -not $link) { continue }

        $desc = ''
        if ($n.description) { $desc = if ($n.description -is [System.Xml.XmlElement]) { $n.description.InnerText } else { [string]$n.description } }
        elseif ($n.summary) { $desc = if ($n.summary -is [System.Xml.XmlElement]) { $n.summary.InnerText } else { [string]$n.summary } }

        $img = $null
        # media:content / media:thumbnail / enclosure
        foreach ($tag in @('content', 'thumbnail')) {
            $media = $n.GetElementsByTagName("media:$tag")
            if ($media.Count -gt 0 -and $media[0].url) { $img = $media[0].url; break }
        }
        if (-not $img -and $n.enclosure -and $n.enclosure.url -and ($n.enclosure.type -like 'image*')) { $img = $n.enclosure.url }
        if (-not $img) { $img = First-ImageFromHtml $desc }

        $dateRaw = if ($n.pubDate) { [string]$n.pubDate } elseif ($n.published) { [string]$n.published } elseif ($n.updated) { [string]$n.updated } else { $null }

        $items += [ordered]@{
            id       = $source.id + ':' + (Get-StableId $link)
            sourceId = $source.id
            source   = $source.name
            platform = $source.platform
            category = $source.category
            title    = ([string]$title).Trim()
            url      = [string]$link
            image    = $img
            summary  = Strip-Html $desc
            date     = (Parse-Date $dateRaw).ToString('o')
        }
    }
    return $items
}

function Fetch-Rss($source) {
    $raw = Get-Url $source.url
    # rimuove eventuale BOM/spazi prima della dichiarazione XML
    $raw = $raw.Substring($raw.IndexOf('<'))
    Parse-Rss ([xml]$raw) $source
}

function Resolve-ChannelId($source) {
    if ($source.channelId) { return $source.channelId }
    if ($channelCache.ContainsKey($source.id)) { return $channelCache[$source.id] }
    $html = Get-Url ('https://www.youtube.com/' + $source.handle) $ytSession
    $id = $null
    if ($html -match '"externalId":"(UC[0-9A-Za-z_-]{22})"') { $id = $Matches[1] }
    else {
        # fallback: l'UC id più frequente nella pagina è quello del canale
        $groups = [regex]::Matches($html, 'UC[0-9A-Za-z_-]{22}') | Group-Object Value | Sort-Object Count -Descending
        if ($groups.Count -gt 0) { $id = $groups[0].Name }
    }
    if (-not $id) { throw "channelId non trovato per $($source.handle)" }
    $channelCache[$source.id] = $id
    return $id
}

function Fetch-YouTube($source) {
    $channelId = Resolve-ChannelId $source
    $xml = [xml](Get-Url "https://www.youtube.com/feeds/videos.xml?channel_id=$channelId")
    $items = @()
    foreach ($e in ($xml.feed.entry | Select-Object -First $maxPerSource)) {
        $videoId = [string]$e.videoId
        if (-not $videoId) { continue }
        $items += [ordered]@{
            id       = $source.id + ':' + $videoId
            sourceId = $source.id
            source   = $source.name
            platform = 'youtube'
            category = $source.category
            title    = [string]$e.title
            url      = "https://www.youtube.com/watch?v=$videoId"
            image    = "https://i.ytimg.com/vi/$videoId/hqdefault.jpg"
            summary  = ''
            videoId  = $videoId
            date     = (Parse-Date ([string]$e.published)).ToString('o')
        }
    }
    return $items
}

function Fetch-Reddit($source) {
    $json = Get-Url "https://www.reddit.com/r/$($source.sub)/hot.json?limit=$maxPerSource&raw_json=1" | ConvertFrom-Json
    $items = @()
    foreach ($c in $json.data.children) {
        $d = $c.data
        if ($d.stickied) { continue }
        $img = $null
        if ($d.preview -and $d.preview.images) { $img = $d.preview.images[0].source.url }
        elseif ($d.thumbnail -like 'http*') { $img = $d.thumbnail }
        $items += [ordered]@{
            id       = $source.id + ':' + $d.id
            sourceId = $source.id
            source   = 'r/' + $d.subreddit
            platform = 'reddit'
            category = $source.category
            title    = $d.title
            url      = 'https://www.reddit.com' + $d.permalink
            image    = $img
            summary  = Strip-Html $d.selftext
            score    = $d.ups
            comments = $d.num_comments
            date     = ([DateTimeOffset]::FromUnixTimeSeconds([long]$d.created_utc)).UtcDateTime.ToString('o')
        }
    }
    return $items
}

# --- esecuzione ---
$byCategory = @{}
$ok = 0; $failed = 0
foreach ($source in $catalog.sources) {
    if ($source.live) { continue }
    try {
        $items = switch ($source.platform) {
            'rss'     { Fetch-Rss $source }
            'youtube' { Fetch-YouTube $source }
            'reddit'  { Fetch-Reddit $source }
            default   { @() }
        }
        if (-not $byCategory.ContainsKey($source.category)) { $byCategory[$source.category] = @() }
        $byCategory[$source.category] += $items
        $ok++
        Write-Host ("OK   {0,-20} {1,3} elementi" -f $source.id, $items.Count)
    } catch {
        $failed++
        Write-Warning ("FAIL {0,-20} {1}" -f $source.id, $_.Exception.Message)
    }
}

$written = 0; $unchanged = 0
foreach ($cat in $byCategory.Keys) {
    $sorted = @($byCategory[$cat] | Sort-Object { $_.date } -Descending | Select-Object -First $maxPerCategory)
    $file = Join-Path $outDir "$cat.json"

    # Firma del contenuto: se le notizie sono le stesse non riscriviamo il file,
    # così il ciclo ogni 5 minuti non genera commit a vuoto.
    $newSig = ($sorted | ForEach-Object { "$($_.id)|$($_.date)|$($_.title)" }) -join "`n"
    $oldSig = $null
    if (Test-Path $file) {
        try {
            $old = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json
            $oldSig = ($old.items | ForEach-Object { "$($_.id)|$($_.date)|$($_.title)" }) -join "`n"
        } catch { }
    }
    if ($newSig -eq $oldSig) {
        $unchanged++
        Write-Host ("=    {0,-16} invariato" -f $cat)
        continue
    }

    $payload = [ordered]@{
        category = $cat
        updated  = (Get-Date).ToUniversalTime().ToString('o')
        items    = $sorted
    }
    [System.IO.File]::WriteAllText($file, ($payload | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    $written++
    Write-Host ("NEW  {0,-16} {1} elementi" -f $cat, $sorted.Count)
}
Write-Host "Categorie aggiornate: $written | invariate: $unchanged"

if ($channelCache.Count -gt 0) {
    [System.IO.File]::WriteAllText($channelCacheFile, ([PSCustomObject]$channelCache | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
}

Write-Host "Completato: $ok fonti OK, $failed fallite."
if ($ok -eq 0) { exit 1 }
