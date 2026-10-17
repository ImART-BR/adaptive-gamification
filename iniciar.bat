@echo off
rem Inicia o app de flashcards em http://localhost:8787 (experimento DESLIGADO: todos veem a interface uniforme).
rem Basta dar dois cliques neste arquivo. Para parar, feche a janela ou use Ctrl+C.
cd /d "%~dp0"
set "PATH=%~dp0tools\node;%PATH%"

if not exist "packages\app-web\dist\index.html" (
  echo Compilando a interface pela primeira vez...
  call npm.cmd run build:web
)

echo.
echo App em http://localhost:8787
echo Para parar: feche esta janela ou use Ctrl+C.
echo.
if /i not "%~1"=="nobrowser" start "" http://localhost:8787
call npm.cmd run start
pause
