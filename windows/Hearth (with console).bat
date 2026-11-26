@echo off
rem Starts Hearth with a console window that shows what it is doing. Close the window to stop Hearth.
cd /d "%~dp0app"
"%~dp0node\node.exe" server\index.mjs --open
pause
