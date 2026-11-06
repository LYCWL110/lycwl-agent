@echo off
node "%~dp0src\bootstrap\main.ts" %*
exit /b %errorlevel%
