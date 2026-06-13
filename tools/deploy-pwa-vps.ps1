param(
    [string]$HostName = "138.128.192.245",
    [string]$User = "root",
    [int]$Port = 22,
    [string]$RemoteRoot = "/opt/hub-mobile/pwa",
    [string]$LocalPwa = "",
    [string]$BackupLabel = ""
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
if (-not $LocalPwa) {
    $LocalPwa = Join-Path $repo "mobile\pwa"
}
if (-not (Test-Path (Join-Path $LocalPwa "app.js"))) {
    throw "PWA app.js not found under $LocalPwa"
}

$required = @(
    "app.js",
    "sw.js",
    "styles.css",
    "index.html",
    "manifest.json",
    "offline.html",
    "icons",
    "vendor"
)
foreach ($item in $required) {
    if (-not (Test-Path (Join-Path $LocalPwa $item))) {
        throw "Required PWA asset missing: $item"
    }
}

$app = Get-Content (Join-Path $LocalPwa "app.js") -Raw
$sw = Get-Content (Join-Path $LocalPwa "sw.js") -Raw
if ($app -notmatch "v0\.5\.83") {
    throw "Local app.js does not contain expected PWA version v0.5.83"
}
if ($sw -notmatch "hub-mobile-v110") {
    throw "Local sw.js does not contain expected cache hub-mobile-v110"
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
if (-not $BackupLabel) {
    $BackupLabel = "pwa-v0583-$stamp"
}
$target = "$User@$HostName"
$sshArgs = @("-p", "$Port", "-o", "ConnectTimeout=20", $target)
$scpArgs = @("-P", "$Port", "-o", "ConnectTimeout=20")
$remoteBackup = "/opt/hub-mobile/backups/$stamp/$BackupLabel"

Write-Host "[deploy-pwa] target=${target}:$RemoteRoot"
Write-Host "[deploy-pwa] backup=$remoteBackup"

ssh @sshArgs "mkdir -p '$remoteBackup' '$RemoteRoot' && cp -a '$RemoteRoot'/app.js '$RemoteRoot'/sw.js '$RemoteRoot'/styles.css '$RemoteRoot'/index.html '$remoteBackup'/ 2>/dev/null || true"
if ($LASTEXITCODE -ne 0) { throw "remote backup command failed" }

scp @scpArgs -r `
    (Join-Path $LocalPwa "app.js") `
    (Join-Path $LocalPwa "sw.js") `
    (Join-Path $LocalPwa "styles.css") `
    (Join-Path $LocalPwa "index.html") `
    (Join-Path $LocalPwa "manifest.json") `
    (Join-Path $LocalPwa "offline.html") `
    (Join-Path $LocalPwa "icons") `
    (Join-Path $LocalPwa "vendor") `
    "${target}:$RemoteRoot/"
if ($LASTEXITCODE -ne 0) { throw "scp upload failed" }

ssh @sshArgs "find '$RemoteRoot' -type d -exec chmod 755 {} \; && find '$RemoteRoot' -type f -exec chmod 644 {} \;"
if ($LASTEXITCODE -ne 0) { throw "remote chmod command failed" }

ssh @sshArgs "grep -q 'v0.5.83' '$RemoteRoot/app.js' && grep -q 'sw v110' '$RemoteRoot/app.js' && grep -q 'hub-mobile-v110' '$RemoteRoot/app.js' && grep -q 'hub-mobile-v110' '$RemoteRoot/sw.js' && grep -q 'desktop right-click session actions' '$RemoteRoot/app.js' && grep -q 'desktop remote session management' '$RemoteRoot/app.js' && grep -q 'card source hub routing' '$RemoteRoot/app.js' && grep -q 'pairing hub list viewport fit' '$RemoteRoot/app.js' && grep -q 'scrollIntoView' '$RemoteRoot/app.js' && grep -q 'overscroll-behavior:contain' '$RemoteRoot/styles.css' && grep -q 'artifact overlay cleanup' '$RemoteRoot/app.js' && grep -q 'synced debug SW cache version' '$RemoteRoot/app.js' && grep -q 'desktop persistent session sidebar' '$RemoteRoot/app.js' && grep -q '_isDesktopPersistentDrawer' '$RemoteRoot/app.js' && grep -q 'Desktop/company-browser mode' '$RemoteRoot/styles.css' && grep -q 'browser back closes drawer and Hub View' '$RemoteRoot/app.js' && grep -q 'drawerBackCloseCount' '$RemoteRoot/app.js' && grep -q '_handleDrawerPopState' '$RemoteRoot/app.js' && grep -q 'hubViewBackCloseCount' '$RemoteRoot/app.js' && grep -q '_handleHubViewPopState' '$RemoteRoot/app.js' && grep -q 'mobile touch drag mode' '$RemoteRoot/app.js' && grep -q 'hubViewTouchDragCount' '$RemoteRoot/app.js' && grep -q 'pinch-in fit reset' '$RemoteRoot/app.js' && grep -q 'hubViewPinchFitResetCount' '$RemoteRoot/app.js' && grep -q 'one-tap fit reset after pinch zoom' '$RemoteRoot/app.js' && grep -q 'pinch gesture frame hold' '$RemoteRoot/app.js' && grep -q 'hubViewPinchFrameHoldCount' '$RemoteRoot/app.js' && grep -q 'mobile pinch-to-zoom' '$RemoteRoot/app.js' && grep -q '_hubViewTouchDistance' '$RemoteRoot/app.js' && grep -q 'hubViewPinchZoomCount' '$RemoteRoot/app.js' && grep -q 'pinch zoom' '$RemoteRoot/app.js' && grep -q 'touch-action:none' '$RemoteRoot/styles.css' && grep -q 'screen wake lock for long live-control sessions' '$RemoteRoot/app.js' && grep -q '_syncHubViewWakeLock' '$RemoteRoot/app.js' && grep -q '_releaseHubViewWakeLock' '$RemoteRoot/app.js' && grep -q 'WebSocket reconnect state restore' '$RemoteRoot/app.js' && grep -q '_handleGatewayReconnect' '$RemoteRoot/app.js' && grep -q 'gateway-reconnect' '$RemoteRoot/app.js' && grep -q 'bounded coordinate mapping' '$RemoteRoot/app.js' && grep -q 'Math.min(width - 1' '$RemoteRoot/app.js' && grep -q 'multi-level local zoom' '$RemoteRoot/app.js' && grep -q '_hubViewZoomLevels' '$RemoteRoot/app.js' && grep -q '_applyHubViewZoom' '$RemoteRoot/app.js' && grep -q 'setProperty.*width' '$RemoteRoot/app.js' && grep -q 'flex:0 0 auto' '$RemoteRoot/styles.css' && grep -q 'stream watchdog and viewport resubscribe' '$RemoteRoot/app.js' && grep -q '_checkHubViewStreamWatchdog' '$RemoteRoot/app.js' && grep -q '_scheduleHubViewViewportResubscribe' '$RemoteRoot/app.js' && grep -q 'hubViewStreamRestartCount' '$RemoteRoot/app.js' && grep -q 'subscription-style streaming frames' '$RemoteRoot/app.js' && grep -q 'hub-view-sub' '$RemoteRoot/app.js' && grep -q 'hub-view-unsub' '$RemoteRoot/app.js' && grep -q '_subscribeHubViewStream' '$RemoteRoot/app.js' && grep -q 'hubViewStreamSubscribed' '$RemoteRoot/app.js' && grep -q 'post-input fast frame burst' '$RemoteRoot/app.js' && grep -q '_armHubViewFastFrames' '$RemoteRoot/app.js' && grep -q 'lastHubViewFrameStats' '$RemoteRoot/app.js' && grep -q 'foreground resume sync' '$RemoteRoot/app.js' && grep -q '_bindForegroundResume' '$RemoteRoot/app.js' && grep -q '_handleForegroundResume' '$RemoteRoot/app.js' && grep -q 'fullscreen keyboard lock' '$RemoteRoot/app.js' && grep -q '_syncHubViewKeyboardLock' '$RemoteRoot/app.js' && grep -q 'hv-key-lock-on' '$RemoteRoot/styles.css' && grep -q 'keyboard capture toggle' '$RemoteRoot/app.js' && grep -q 'toggleHubViewKeyboardCapture' '$RemoteRoot/app.js' && grep -q 'hv-keyboard-capture-off' '$RemoteRoot/styles.css' && grep -q 'desktop fullscreen' '$RemoteRoot/app.js' && grep -q 'toggleHubViewFullscreen' '$RemoteRoot/app.js' && grep -q 'hub-view-fullscreen' '$RemoteRoot/app.js' && grep -q 'hub-view-fullscreen' '$RemoteRoot/styles.css' && grep -q 'middle-button canvas pan' '$RemoteRoot/app.js' && grep -q '_startHubViewCanvasPan' '$RemoteRoot/app.js' && grep -q 'preserved 1X pan position' '$RemoteRoot/app.js' && grep -q 'hv-canvas-pan-active' '$RemoteRoot/styles.css' && grep -q 'two-finger canvas pan' '$RemoteRoot/app.js' && grep -q '_hubViewTouchCenter' '$RemoteRoot/app.js' && grep -q 'compact modifier toolbar' '$RemoteRoot/app.js' && grep -q 'touch modifier latch' '$RemoteRoot/app.js' && grep -q 'hub-view-mod' '$RemoteRoot/app.js' && grep -q '_renderHubViewMouseModifiers' '$RemoteRoot/app.js' && grep -q 'mouse modifier passthrough' '$RemoteRoot/app.js' && grep -q '_hubViewModifiersFromEvent' '$RemoteRoot/app.js' && grep -q 'post-input boost frames' '$RemoteRoot/app.js' && grep -q '_boostHubViewFrame' '$RemoteRoot/app.js' && grep -q 'touch long-right-click ghost guard' '$RemoteRoot/app.js' && grep -q '_hubViewSuppressNextClickUntil' '$RemoteRoot/app.js' && grep -q 'paste bridge' '$RemoteRoot/app.js' && grep -q 'pasteHubViewText' '$RemoteRoot/app.js' && grep -q 'toolbar-stable bidirectional clipboard' '$RemoteRoot/app.js' && grep -q 'desktop keyboard parity' '$RemoteRoot/app.js' && grep -q 'NumpadEnter' '$RemoteRoot/app.js' && grep -q 'F24' '$RemoteRoot/app.js' && grep -q 'PrintScreen' '$RemoteRoot/app.js' && grep -q 'adaptive resolution stable-node JPEG live frames' '$RemoteRoot/app.js' && grep -q 'clipboard-write' '$RemoteRoot/app.js' && grep -q 'hub-view-setclip' '$RemoteRoot/app.js' && grep -q 'hub-view-clip.*hub-view-setclip.*hub-view-file' '$RemoteRoot/styles.css' && grep -q 'hub-view-mod' '$RemoteRoot/styles.css' && grep -q 'gap:7px' '$RemoteRoot/styles.css' && grep -q '_hubViewFrameWidth' '$RemoteRoot/app.js' && grep -q 'hubViewLiveMinDelayMs' '$RemoteRoot/app.js' && grep -q '_holdHubViewFrameReplacement' '$RemoteRoot/app.js' && grep -q 'dataset.hvBound' '$RemoteRoot/app.js' && grep -q 'image/jpeg' '$RemoteRoot/app.js' && grep -q 'mouse-move' '$RemoteRoot/app.js' && grep -q '_handleHubViewDrop' '$RemoteRoot/app.js' && grep -q 'file-transfer' '$RemoteRoot/app.js' && grep -q 'hub-view-file' '$RemoteRoot/styles.css' && grep -q 'hv-drop-active' '$RemoteRoot/styles.css'"
if ($LASTEXITCODE -ne 0) { throw "remote verification failed" }

ssh @sshArgs "curl -k -fsSI https://127.0.0.1:8443/vendor/xterm/xterm.js | grep -qi 'content-type: application/javascript' && curl -k -fsSI https://127.0.0.1:8443/vendor/xterm/addon-fit.js | grep -qi 'content-type: application/javascript' && curl -k -fsSI https://127.0.0.1:8443/vendor/xterm/xterm.css | grep -qi 'content-type: text/css'"
if ($LASTEXITCODE -ne 0) { throw "remote vendor content-type verification failed" }

Write-Host "[deploy-pwa] DONE"









