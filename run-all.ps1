$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendPath = Join-Path $base 'backend'
$frontendPath = Join-Path $base 'frontend'
$pythonPath = Join-Path $base 'python-service'

function Start-Window($title, $workDir, $command) {
    $args = @('-NoExit','-Command', "Set-Location '$workDir'; $command")
    Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Normal -WorkingDirectory $workDir
}

Write-Host "Starting KachingScanner services..."
Start-Window "KachingScanner Backend" $backendPath "npm start"
Start-Window "KachingScanner Frontend" $frontendPath "npm run dev -- --host"
Start-Window "KachingScanner Python Service" $pythonPath "python -m venv .venv; .\\.venv\\Scripts\\Activate.ps1; pip install -r requirements.txt; uvicorn app:app --reload --host 0.0.0.0 --port 8001"

Write-Host "If npm or python are not installed, install them first and then rerun this script."