@echo off
setlocal

set "EXE=%~dp0out\dist\gpt-tui.exe"

if not defined GROQ_API_KEY (
  for /f "tokens=2,*" %%A in ('reg query "HKCU\Environment" /v GROQ_API_KEY 2^>nul ^| findstr /R /C:"GROQ_API_KEY"') do set "GROQ_API_KEY=%%B"
)

if exist "%EXE%" (
  "%EXE%"
) else (
  python "%~dp0app.py"
)

endlocal
