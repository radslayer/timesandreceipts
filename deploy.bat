@echo off
setlocal EnableDelayedExpansion
title Deploy
REM ==============================================================
REM  Standard deploy script - works in ANY project folder.
REM  Put a copy in the top folder of each project and double-click.
REM    1. Shows what changed and asks before saving
REM    2. Saves ALL changed files as a snapshot (commit)
REM    3. Gets the latest version from GitHub (pull)
REM    4. Uploads to GitHub (push)
REM  It only says "complete" if every step actually worked.
REM ==============================================================

cd /d "%~dp0"
echo Project folder: %CD%
echo.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo ERROR: This folder is not a git project. Nothing was done.
    goto :fail
)

REM ---- Step 1: anything new to save? ----
set "HASCHANGES="
for /f "delims=" %%i in ('git status --porcelain') do set "HASCHANGES=1"

if not defined HASCHANGES (
    echo No new changes on this computer. Checking GitHub for updates...
    echo.
    goto :sync
)

echo These files have changed:
echo --------------------------------------------------------------
git status --short
echo --------------------------------------------------------------
echo Check the list. If you see passwords, keys or .env files, choose N.
echo.
choice /c YN /m "Save and upload these files"
if errorlevel 2 (
    echo.
    echo Cancelled. Nothing was saved or uploaded.
    goto :fail
)

REM ---- Step 2: save the snapshot (commit) ----
echo.
set "MSG="
set /p "MSG=Briefly describe what changed, or press Enter to skip: "
if not defined MSG set "MSG=Update %date% %time%"
> "%TEMP%\deploy_msg.txt" echo(!MSG!

git add -A
git commit -q -F "%TEMP%\deploy_msg.txt"
if errorlevel 1 (
    echo ERROR: Could not save the snapshot. Nothing was uploaded.
    goto :fail
)
echo Snapshot saved on this computer.
echo.

:sync
REM ---- Step 3: get the latest from GitHub (pull) ----
echo Getting the latest version from GitHub...
git pull --rebase
if errorlevel 1 (
    git rebase --abort >nul 2>&1
    echo.
    echo STOPPED: Could not get the latest version from GitHub.
    echo Either there is no internet connection, or the GitHub version
    echo and your changes edit the same lines and conflict.
    echo Your work IS saved on this computer, but was NOT uploaded.
    echo Ask Claude to help, and include the message above.
    goto :fail
)
echo.

REM ---- Step 4: upload to GitHub (push) ----
echo Uploading to GitHub...
git push
if errorlevel 1 (
    echo.
    echo STOPPED: Upload to GitHub failed.
    echo Your work IS saved on this computer, but was NOT uploaded.
    echo Check your internet connection, or ask Claude to help with the message above.
    goto :fail
)

echo.
echo ==============================================================
echo   Deploy complete! Everything is saved and on GitHub.
echo ==============================================================
pause
exit /b 0

:fail
echo.
echo ==============================================================
echo   Deploy did NOT finish. Read the message above.
echo ==============================================================
pause
exit /b 1
