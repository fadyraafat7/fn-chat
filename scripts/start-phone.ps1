$ErrorActionPreference='Stop'
$fnRoot=Split-Path $PSScriptRoot -Parent
$fnAdb=Join-Path $fnRoot '.tools/platform-tools/adb.exe'
if (!(Test-Path $fnAdb)) { throw 'Android platform-tools are missing.' }
$fnRunning=$false
try { $response=Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -TimeoutSec 3; $fnRunning=$response.StatusCode -eq 200 } catch {}
if (!$fnRunning) {
 $fnNode=(Get-Command node.exe).Source
 $fnProcess=Start-Process -FilePath $fnNode -ArgumentList @('server/index.js') -WorkingDirectory $fnRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fnRoot '.tools/server.log') -RedirectStandardError (Join-Path $fnRoot '.tools/server.err') -PassThru
 $fnProcess.Id | Set-Content (Join-Path $fnRoot '.tools/server.pid')
 Start-Sleep -Seconds 4
}
& $fnAdb reverse tcp:3000 tcp:3000
& $fnAdb shell am start -n com.fn.privatechat/.MainActivity
