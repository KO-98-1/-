@echo off
rem SW deliverables app launcher (Windows)
cd /d "%~dp0"
if not exist node_modules call npm install --no-audit --no-fund
node server.mjs --open
pause
