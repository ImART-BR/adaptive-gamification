@echo off
rem Inicia o app com o EXPERIMENTO LIGADO, so para testar a adaptacao no seu computador.
rem Usa um banco separado (data\experimento.db) e RAMP_DAYS=1 (sem inicio suave), para voce ver a adaptacao completa.
rem Metade das contas novas cai no grupo adaptativo; a tela nao mostra o grupo. Se a sua cair no controle, crie outra conta.
rem Nao use com participantes reais: isso depende da aprovacao do CEP e do texto final do TCLE.
cd /d "%~dp0"
set "PATH=%~dp0tools\node;%PATH%"
set "EXPERIMENT=on"
set "RAMP_DAYS=1"
set "DATA_PATH=./data/experimento.db"

if not exist "packages\app-web\dist\index.html" (
  echo Compilando a interface pela primeira vez...
  call npm.cmd run build:web
)

echo.
echo App (EXPERIMENTO LIGADO, teste local) em http://localhost:8787
echo Para parar: feche esta janela ou use Ctrl+C.
echo.
if /i not "%~1"=="nobrowser" start "" http://localhost:8787
call npm.cmd run start
pause
