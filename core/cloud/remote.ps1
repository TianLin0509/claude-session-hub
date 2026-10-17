param([string]$RequestBase64)
$ErrorActionPreference='Stop'
$req=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RequestBase64))|ConvertFrom-Json

function Assert-PlainPath([string]$filename) {
  $next=[IO.Path]::GetFullPath($filename)
  while($next){
    if(Test-Path -LiteralPath $next){
      $entry=Get-Item -LiteralPath $next -Force
      if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'linked_path'}
    }
    $parent=[IO.Path]::GetDirectoryName($next)
    if($parent -eq $next){break};$next=$parent
  }
}
function Assert-Candidate($candidate,[bool]$matchSnapshot) {
  if($candidate.group -notin @('temp','logs')){throw 'invalid_group'}
  $full=[IO.Path]::GetFullPath([string]$candidate.path)
  $roots=if($candidate.group -eq 'temp'){@($req.policy.tempRoots)}else{@($req.policy.logRoots)}
  $dir=[IO.Path]::GetDirectoryName($full)
  if(-not @($roots|Where-Object {[IO.Path]::GetFullPath($_).TrimEnd('\') -ieq $dir.TrimEnd('\')}).Count){throw 'outside_allowed_directory'}
  Assert-PlainPath $full
  $file=Get-Item -LiteralPath $full -Force
  if($file.PSIsContainer -or $file.Length -gt [Math]::Min(10485760,[double]$req.policy.maxFileBytes)){throw 'unsupported_file'}
  if($candidate.group -eq 'temp' -and $file.Extension -notin @('.tmp','.temp')){throw 'unsupported_name'}
  if($candidate.group -eq 'logs' -and $file.Name -notmatch '^.+\.log\.(?:[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2}|old)$'){throw 'active_log'}
  if($file.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddDays(-[Math]::Max(7,[int]$req.policy.minAgeDays))){throw 'recent_file'}
  if($matchSnapshot -and ($file.Length -ne $candidate.bytes -or $file.LastWriteTimeUtc.Ticks.ToString() -ne [string]$candidate.modifiedTicks)){throw 'file_changed'}
  return $file
}
function Get-Plan {
  $found=[Collections.Generic.List[object]]::new();$warnings=[Collections.Generic.List[string]]::new()
  $cap=[Math]::Min(50,[int]$req.policy.maxFiles)
  foreach($group in @('temp','logs')){
    $roots=if($group -eq 'temp'){@($req.policy.tempRoots)}else{@($req.policy.logRoots)}
    foreach($root in $roots){
      if(-not(Test-Path -LiteralPath $root)){continue}
      try{
        Assert-PlainPath $root
        $files=@(Get-ChildItem -LiteralPath $root -File -Force -ErrorAction Stop|Select-Object -First 1001)
        if($files.Count -gt 1000){[void]$warnings.Add('目录文件较多，本次只检查前 1000 项。')}
        foreach($item in ($files|Select-Object -First 1000)){
          if($found.Count -ge $cap){break}
          # Most temp-directory entries are unrelated. Use enumerated metadata
          # before the more expensive full ancestor/identity checks.
          if($item.Length -gt [Math]::Min(10485760,[double]$req.policy.maxFileBytes) -or $item.LastWriteTimeUtc -gt [DateTime]::UtcNow.AddDays(-[Math]::Max(7,[int]$req.policy.minAgeDays))){continue}
          if($group -eq 'temp' -and $item.Extension -notin @('.tmp','.temp')){continue}
          if($group -eq 'logs' -and $item.Name -notmatch '^.+\.log\.(?:[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2}|old)$'){continue}
          try{
            $candidate=[pscustomobject]@{group=$group;path=$item.FullName}
            $file=Assert-Candidate $candidate $false
            [void]$found.Add([pscustomobject]@{id=[Guid]::NewGuid().ToString('N');group=$group;path=$file.FullName;bytes=[double]$file.Length;modifiedTicks=$file.LastWriteTimeUtc.Ticks.ToString()})
          }catch{}
        }
      }catch{[void]$warnings.Add('部分允许目录不可读取，本次未将其计入。')}
    }
  }
  if($found.Count -ge $cap){[void]$warnings.Add('单次最多列出 50 个候选文件，整理后可重新扫描。')}
  return [pscustomobject]@{items=@($found.ToArray());warnings=@($warnings.ToArray()|Select-Object -Unique)}
}
function Initialize-FileHandles {
  if('HubCloudFile' -as [type]){return}
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HubCloudFile {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attr, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int type, ref byte info, uint length);
  static void CheckPath(SafeFileHandle handle, string expected) {
    var name = new StringBuilder(32768);
    uint count = GetFinalPathNameByHandleW(handle, name, (uint)name.Capacity, 0);
    if (count == 0 || count >= name.Capacity) throw new IOException("linked_path");
    string actual = name.ToString();
    if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
    if (!String.Equals(actual, Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new IOException("linked_path");
  }
  public static FileStream OpenChecked(string path, long bytes, long ticks, bool deleteAccess) {
    var handle = CreateFileW(path, 0x80000000u | (deleteAccess ? 0x10000u : 0u), 0, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero);
    try {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      CheckPath(handle, path);
      Info info;
      if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if ((info.Attr & 0x400) != 0 || info.Links != 1) throw new IOException("linked_path");
      long size = ((long)info.SizeHigh << 32) | info.SizeLow;
      long modified = DateTime.FromFileTimeUtc(((long)info.WriteHigh << 32) | info.WriteLow).Ticks;
      if (size != bytes || modified != ticks) throw new IOException("file_changed");
      return new FileStream(handle, FileAccess.Read);
    } catch { handle.Dispose(); throw; }
  }
  public static FileStream CreateArchive(string path) {
    var handle = CreateFileW(path, 0xC0010000, 0, IntPtr.Zero, 1, 0x00200000, IntPtr.Zero);
    try {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      CheckPath(handle, path);
      return new FileStream(handle, FileAccess.ReadWrite);
    } catch { handle.Dispose(); throw; }
  }
  public static void MarkDelete(FileStream stream) {
    byte remove = 1;
    if (!SetFileInformationByHandle(stream.SafeFileHandle, 4, ref remove, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
}
function Invoke-Maintenance {
  Initialize-FileHandles
  $results=[Collections.Generic.List[object]]::new()
  if(@($req.items).Count -gt 50){throw 'too_many_files'}
  foreach($item in @($req.items)){
    $stream=$null;$archive=$null;$gzip=$null;$unzip=$null;$sha=$null;$created=$false;$verified=$false
    $result=[ordered]@{id=[string]$item.id;status='failed';releasedBytes=0;message='file_not_processed'}
    try{
      if(-not(Test-Path -LiteralPath ([string]$item.path))){$result.status='skipped';$result.message='already_absent'}
      else{
        $file=Assert-Candidate $item $true
        # Validate identity and delete through the same exclusive handle.
        $stream=[HubCloudFile]::OpenChecked($file.FullName,[long]$item.bytes,[long]$item.modifiedTicks,$true)
        if($item.group -eq 'temp'){
          [HubCloudFile]::MarkDelete($stream)
          $stream.Dispose();$stream=$null
          $result.status='done';$result.releasedBytes=[double]$item.bytes;$result.message='removed'
        }else{
          $destination=$file.FullName+'.gz'
          if(Test-Path -LiteralPath $destination){
            Assert-PlainPath $destination
            $existing=Get-Item -LiteralPath $destination -Force
            if($existing.Length -gt 10485760){throw 'archive_conflict'}
            $archive=[HubCloudFile]::OpenChecked($destination,$existing.Length,$existing.LastWriteTimeUtc.Ticks,$false)
          }else{
            $archive=[HubCloudFile]::CreateArchive($destination);$created=$true
            $gzip=[IO.Compression.GZipStream]::new($archive,[IO.Compression.CompressionLevel]::Optimal,$true)
            $stream.CopyTo($gzip);$gzip.Dispose();$gzip=$null;$archive.Flush($true)
          }
          $sha=[Security.Cryptography.SHA256]::Create();$stream.Position=0
          $originalHash=[Convert]::ToBase64String($sha.ComputeHash($stream));$archive.Position=0
          try{
            $unzip=[IO.Compression.GZipStream]::new($archive,[IO.Compression.CompressionMode]::Decompress,$true)
            # Bound decompression to the source size; a pre-existing archive is untrusted.
            $buffer=New-Object byte[] 65536;$total=0L
            while(($count=$unzip.Read($buffer,0,$buffer.Length)) -gt 0){$total+=$count;if($total -gt $item.bytes){throw 'archive_conflict'};[void]$sha.TransformBlock($buffer,0,$count,$null,0)}
            [void]$sha.TransformFinalBlock($buffer,0,0);$archiveHash=[Convert]::ToBase64String($sha.Hash)
            $unzip.Dispose();$unzip=$null
          }catch{throw 'archive_conflict'}
          if($originalHash -ne $archiveHash){throw 'archive_conflict'}
          $compressedBytes=$archive.Length
          if($created -and $compressedBytes -ge $item.bytes){$result.status='skipped';$result.message='no_space_saved'}
          else{
            $verified=$true
            [HubCloudFile]::MarkDelete($stream);$stream.Dispose();$stream=$null
            $result.status='done';$result.releasedBytes=[double]$item.bytes-$(if($created){$compressedBytes}else{0});$result.message='compressed_verified'
          }
        }
      }
    }catch{
      $known=@('linked_path','outside_allowed_directory','unsupported_file','unsupported_name','active_log','recent_file','file_changed','archive_conflict')
      $failure=$_.Exception;while($failure.InnerException){$failure=$failure.InnerException}
      $result.message=if($failure.Message -in $known){$failure.Message}else{'file_busy_or_unavailable'}
    }finally{
      if($created -and -not $verified -and $archive){try{[HubCloudFile]::MarkDelete($archive)}catch{}}
      foreach($resource in @($gzip,$unzip,$sha,$archive,$stream)){if($resource){try{$resource.Dispose()}catch{}}}
    }
    [void]$results.Add([pscustomobject]$result)
  }
  return [pscustomobject]@{results=@($results.ToArray())}
}
function Get-Metrics {
  $all=@(Get-CimInstance Win32_Process);$listeners=@(Get-NetTCPConnection -State Listen)
  $groups=@(foreach($d in @($req.definitions)){
    $listener=$listeners|Where-Object LocalPort -eq $d.port|Select-Object -First 1
    $ids=[Collections.Generic.HashSet[int]]::new()
    if($listener){
      $root=$all|Where-Object ProcessId -eq $listener.OwningProcess|Select-Object -First 1
      $visited=[Collections.Generic.HashSet[int]]::new()
      while($root -and $visited.Add([int]$root.ProcessId)){
        $parent=$all|Where-Object ProcessId -eq $root.ParentProcessId|Select-Object -First 1
        if($parent -and $parent.Name -match '^python(w)?\.exe$' -and $parent.CreationDate -le $root.CreationDate){$root=$parent}else{break}
      }
      if($root){[void]$ids.Add([int]$root.ProcessId)}
      do{$added=0;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $p.CreationDate -ge $root.CreationDate -and $ids.Add([int]$p.ProcessId)){$added++}}}while($added -gt 0)
    }
    [pscustomobject]@{id=$d.id;port=$d.port;ids=@($ids)}
  })
  $cores=[int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
  $first=@{};Get-Process|ForEach-Object{try{$first[[int]$_.Id]=@([double]$_.CPU,$_.StartTime.Ticks)}catch{}}
  $sw=[Diagnostics.Stopwatch]::StartNew();Start-Sleep -Seconds 4
  $second=@{};Get-Process|ForEach-Object{try{$second[[int]$_.Id]=@([double]$_.CPU,$_.StartTime.Ticks,[double]$_.WorkingSet64)}catch{}}
  $elapsed=$sw.Elapsed.TotalSeconds
  $metrics=@(foreach($g in $groups){
    $cpu=0.0;$ws=0.0;$stable=$true
    foreach($processId in $g.ids){if($first.ContainsKey([int]$processId) -and $second.ContainsKey([int]$processId) -and $first[[int]$processId][1] -eq $second[[int]$processId][1]){$cpu += [Math]::Max(0,$second[[int]$processId][0]-$first[[int]$processId][0]);$ws += $second[[int]$processId][2]}else{$stable=$false}}
    [pscustomobject]@{id=$g.id;port=$g.port;running=($g.ids.Count -gt 0);stable=$stable;processCount=$g.ids.Count;cpuPct=$(if($stable -and $g.ids.Count){[Math]::Round([Math]::Min(100,100*$cpu/$elapsed/[Math]::Max(1,$cores)),2)}else{$null});workingSetBytes=$(if($stable -and $g.ids.Count){$ws}else{$null})}
  })
  $os=Get-CimInstance Win32_OperatingSystem;$disk=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'";$cpuPct=$null
  try{$cpuPct=[double](Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime}catch{}
  return [pscustomobject]@{collectedAt=[DateTime]::UtcNow.ToString('o');sampleSeconds=[Math]::Round($elapsed,2);cores=$cores;host=[pscustomobject]@{cpuPct=$cpuPct;memoryTotalBytes=[double]$os.TotalVisibleMemorySize*1024;memoryFreeBytes=[double]$os.FreePhysicalMemory*1024;diskTotalBytes=[double]$disk.Size;diskFreeBytes=[double]$disk.FreeSpace;uptimeSeconds=[Math]::Round(((Get-Date)-$os.LastBootUpTime).TotalSeconds);os=[string]$os.Caption};services=$metrics}
}
function Get-PrivateUrl {
  $config=Invoke-RestMethod -Uri 'http://127.0.0.1:2019/config/' -TimeoutSec 6
  $paths=[Collections.Generic.List[string]]::new()
  function Visit($node){
    if($null -eq $node -or $node -is [string]){return}
    if($node -is [array]){foreach($value in $node){Visit $value};return}
    foreach($property in $node.PSObject.Properties){
      if($property.Name -eq 'path'){foreach($value in @($property.Value)){if([string]$value -match '^/drop/[A-Za-z0-9_-]+/\*?$'){[void]$paths.Add(([string]$value).TrimEnd('*'))}}}
      if($property.Value -is [array] -or $property.Value -is [pscustomobject]){Visit $property.Value}
    }
  }
  Visit $config
  $unique=@($paths.ToArray()|Select-Object -Unique)
  if($unique.Count -ne 1){throw 'private_entry_unknown'}
  return [pscustomobject]@{url='https://me.lt-stockpartner.tech'+$unique[0]}
}
try{
  $result=switch($req.operation){'metrics'{Get-Metrics}'plan'{Get-Plan}'execute'{Invoke-Maintenance}'private-url'{Get-PrivateUrl}default{throw 'unsupported_operation'}}
  $result|ConvertTo-Json -Depth 8 -Compress
}catch{[pscustomobject]@{error='cloud_remote_failed'}|ConvertTo-Json -Compress;exit 1}
