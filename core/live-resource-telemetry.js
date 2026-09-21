'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const PROCESS_SCRIPT = `
function Snapshot {
  $rows = @(Get-Process -ErrorAction Stop | ForEach-Object {
    $p = $_; $cpu = $null; $started = $null
    try { $cpu = $p.TotalProcessorTime.TotalMilliseconds; $started = $p.StartTime.ToUniversalTime().Ticks.ToString() } catch {}
    if ($p.Id -gt 0) { [PSCustomObject]@{ pid=$p.Id; name=$p.ProcessName; started=$started; cpuMs=$cpu; memoryBytes=$p.WorkingSet64 } }
  })
  [PSCustomObject]@{ at=[Diagnostics.Stopwatch]::GetTimestamp(); rows=$rows }
}
$before = Snapshot
Start-Sleep -Milliseconds 700
$after = Snapshot
@{ before=$before.rows; after=$after.rows; windowMs=1000.0*($after.at-$before.at)/[Diagnostics.Stopwatch]::Frequency } | ConvertTo-Json -Compress -Depth 5
`;

function rankProcesses(sample, cpuCount) {
  if (!Array.isArray(sample.before) || !Array.isArray(sample.after) || !(sample.windowMs > 0)) {
    throw new Error('Invalid process sample');
  }
  const key = row => `${row.pid}:${row.started}`;
  const before = new Map(sample.before.filter(row => row.started != null && Number.isFinite(row.cpuMs)).map(row => [key(row), row.cpuMs]));
  const rows = sample.after.filter(row => row.pid > 0).map(row => {
    const previous = before.get(key(row));
    const delta = Number.isFinite(row.cpuMs) && previous != null ? row.cpuMs - previous : null;
    return {
      pid: row.pid, name: String(row.name), memoryBytes: row.memoryBytes,
      cpuPct: delta != null && delta >= 0 ? Math.min(100, 100 * delta / sample.windowMs / Math.max(1, cpuCount)) : null,
    };
  });
  if (!rows.length) throw new Error('No processes returned');
  return {
    cpu: rows.filter(row => row.cpuPct != null).sort((a, b) => b.cpuPct - a.cpuPct || a.pid - b.pid).slice(0, 3),
    memory: rows.filter(row => Number.isFinite(row.memoryBytes)).sort((a, b) => b.memoryBytes - a.memoryBytes || a.pid - b.pid).slice(0, 3),
    windowMs: sample.windowMs,
    unreadableCpuCount: rows.filter(row => row.cpuPct == null).length,
  };
}

function networkDelta(previous, current) {
  if (!previous || !(current.at > previous.at)) return { status: 'warming' };
  const old = new Map(previous.adapters.map(row => [row.id, row]));
  if (current.adapters.length !== old.size || current.adapters.some(row => !old.has(row.id))) return { status: 'warming' };
  let received = 0; let sent = 0;
  for (const row of current.adapters) {
    const prior = old.get(row.id);
    if (row.received < prior.received || row.sent < prior.sent) return { status: 'warming' };
    received += row.received - prior.received;
    sent += row.sent - prior.sent;
  }
  const seconds = (current.at - previous.at) / 1000;
  return { status: 'ok', downloadBps: received / seconds, uploadBps: sent / seconds, windowMs: current.at - previous.at };
}

function createLiveResourceTelemetry(options = {}) {
  const run = options.execFile || promisify(execFile);
  const now = options.now || Date.now;
  const platform = options.platform || process.platform;
  const cpuCount = options.cpuCount || os.cpus().length;
  let physicalIds = null; let discoveredAt = 0; let baseline = null;
  let networkCache = null; let networkPending = null;
  let processCache = null; let processPending = null;

  async function powershell(script) {
    if (platform !== 'win32') throw new Error('Windows telemetry unavailable');
    const prefix = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8;\n";
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prefix + script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
    });
    return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  }

  function sampleNetwork() {
    if (networkPending) return networkPending;
    if (networkCache && now() - networkCache.sampledAt < 2500) return Promise.resolve(networkCache);
    networkPending = (async () => {
      try {
        // Discover physical adapters slowly; use cheap .NET byte counters on each tick.
        // TUN/VPN virtual adapters are excluded to avoid counting the same bytes twice.
        const discover = !physicalIds || now() - discoveredAt > 60000;
        const idsScript = discover
          ? '$ids = @(Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object { $_.InterfaceGuid.ToString().Trim("{}").ToLowerInvariant() })'
          : `$ids = @('${physicalIds.join("','")}')`;
        const value = await powershell(`${idsScript}
$rows = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $ids -contains $_.Id.Trim('{}').ToLowerInvariant() } | ForEach-Object {
  $stats = $_.GetIPv4Statistics()
  @{ id=$_.Id; name=$_.Name; received=$stats.BytesReceived; sent=$stats.BytesSent }
})
@{ ids=$ids; adapters=$rows; at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress -Depth 4`);
        if (!Array.isArray(value.adapters) || !Array.isArray(value.ids)
            || value.ids.some(id => !/^[a-f0-9-]+$/i.test(id))
            || value.adapters.some(row => !Number.isFinite(row.received) || !Number.isFinite(row.sent))) throw new Error('Invalid network sample');
        physicalIds = value.ids;
        if (discover) discoveredAt = now();
        networkCache = { ...networkDelta(baseline, value), sampledAt: now(), adapters: value.adapters.map(row => row.name), scope: 'physical' };
        if (!value.adapters.length) networkCache.status = 'disconnected';
        baseline = value;
      } catch (error) {
        baseline = null;
        networkCache = { status: 'unavailable', sampledAt: now(), error: error.message };
      }
      return networkCache;
    })().finally(() => { networkPending = null; });
    return networkPending;
  }

  function sampleProcesses() {
    if (processPending) return processPending;
    if (processCache && now() - processCache.sampledAt < 5000) return Promise.resolve(processCache);
    processPending = (async () => {
      try {
        const ranked = rankProcesses(await powershell(PROCESS_SCRIPT), cpuCount);
        processCache = { status: 'ok', ...ranked, sampledAt: now() };
      } catch (error) {
        processCache = { status: 'unavailable', error: error.message, sampledAt: now() };
      }
      return processCache;
    })().finally(() => { processPending = null; });
    return processPending;
  }
  return { sampleNetwork, sampleProcesses };
}

module.exports = { createLiveResourceTelemetry, rankProcesses, networkDelta };
