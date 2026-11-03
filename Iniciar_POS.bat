@echo off
title Servidor POS Activo
cd /d "%~dp0"
start /b node server.js
timeout /t 2 /nobreak >nul
start msedge --app=http://localhost:3000