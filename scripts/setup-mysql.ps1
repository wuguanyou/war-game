$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Host 'Local MySQL setup. The administrator password will not be saved.'
$mysqlAdmin = Read-Host 'MySQL administrator username (Enter = root)'
if ([string]::IsNullOrWhiteSpace($mysqlAdmin)) { $mysqlAdmin = 'root' }
$mysqlSecret = Read-Host 'MySQL administrator password' -AsSecureString
$mysqlSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mysqlSecret)
try {
    $mysqlStart = New-Object System.Diagnostics.ProcessStartInfo
    $mysqlStart.FileName = (Get-Command node -ErrorAction Stop).Source
    $mysqlStart.Arguments = 'scripts/setup-mysql.js'
    $mysqlStart.WorkingDirectory = (Get-Location).Path
    $mysqlStart.UseShellExecute = $false
    $mysqlStart.RedirectStandardInput = $true
    $mysqlProcess = [System.Diagnostics.Process]::Start($mysqlStart)
    $mysqlInput = @{
        user = $mysqlAdmin
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mysqlSecretPointer)
    } | ConvertTo-Json -Compress
    $mysqlProcess.StandardInput.WriteLine($mysqlInput)
    $mysqlProcess.StandardInput.Close()
    $mysqlInput = $null
    $mysqlProcess.WaitForExit()
    exit $mysqlProcess.ExitCode
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mysqlSecretPointer)
    $mysqlSecret.Dispose()
}
