@echo off
if exist "%~dp0src\bootstrap\main.ts" (
  node "%~dp0src\bootstrap\main.ts" %*
) else (
  node "%~dp0dist\bootstrap\main.js" %*
)
exit /b %errorlevel%
