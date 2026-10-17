@echo off
rem Abre a simulação visual da gamificação adaptativa em http://localhost:5174 (não usa servidor nem banco de dados).
rem Basta dar dois cliques neste arquivo. Para parar, feche a janela ou use Ctrl+C.
cd /d "%~dp0"
set "PATH=%~dp0tools\node;%PATH%"

echo.
echo Simulacao em http://localhost:5174
echo Para parar: feche esta janela ou use Ctrl+C.
echo.
call npm.cmd run sim:web
pause
