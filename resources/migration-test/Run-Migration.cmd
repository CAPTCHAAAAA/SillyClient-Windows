@echo off
setlocal
if not "%~1"=="" goto run
"%~dp0resources\runtime\node\node.exe" --experimental-strip-types "%~dp0resources\migration-tool\scripts\data-migration.mjs" --help
pause
exit /b 0
:run
"%~dp0resources\runtime\node\node.exe" --experimental-strip-types "%~dp0resources\migration-tool\scripts\data-migration.mjs" %*
exit /b %errorlevel%
