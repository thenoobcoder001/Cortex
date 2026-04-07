Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "Running GPT TUI smoke test..."

python -m py_compile gpt_tui\ui\app.py gpt_tui\providers\gemini_cli_provider.py gpt_tui\ui\tool_executor.py
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

pytest -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Smoke test passed."
