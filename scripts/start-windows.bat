@echo off
REM Starts the Crystal Drinks server. Used by the Windows Startup shortcut / Task Scheduler.
cd /d "%~dp0.."
node server.js
