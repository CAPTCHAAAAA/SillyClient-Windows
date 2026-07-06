@echo off
setlocal
cd /d "%TARVEN_SERVER_DIR%"
set HOME=%TARVEN_HOME%
set TMPDIR=%TARVEN_TMP%
set NODE_ENV=production
set AUTO_LAUNCH=false
set NO_BROWSER=true
"%TARVEN_NODE%" server.js
