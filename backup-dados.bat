@echo off
setlocal
title Backup dos dados - Buscador NFS-e
REM ============================================================
REM  Gera um ZIP com tudo o que precisa para restaurar o sistema:
REM  banco de dados, XMLs, logs e o .env (chave mestra).
REM  Pode rodar com o painel aberto.
REM
REM  Uso:
REM    backup-dados.bat            pergunta destino e opcoes
REM    backup-dados.bat auto       sem perguntas (para o Agendador
REM                                de Tarefas): salva em .\backups
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  if /i not "%~1"=="auto" pause
  exit /b 1
)
if not exist "node_modules\" (
  echo [ERRO] Dependencias nao instaladas. Rode o iniciar.bat uma vez antes.
  if /i not "%~1"=="auto" pause
  exit /b 1
)
if not exist ".env" (
  echo [ERRO] Arquivo .env nao encontrado. Rode o iniciar.bat uma vez antes.
  if /i not "%~1"=="auto" pause
  exit /b 1
)

set DESTINO=%~dp0backups
set ENV_OPT=
if /i "%~1"=="auto" goto executar

echo.
echo  Backup dos dados do Buscador NFS-e
echo  ----------------------------------
echo  Dica: salve tambem fora deste computador (pendrive, HD externo,
echo  pasta de rede ou pasta sincronizada com a nuvem).
echo.
set /p DESTINO=Pasta de destino [%DESTINO%]: 
echo.
echo  O .env contem a NFSE_MASTER_KEY, que decifra os certificados.
echo  Sem ela o backup nao restaura os certificados.
set INCLUIR_ENV=S
set /p INCLUIR_ENV=Incluir o .env no backup? (S/N) [S]: 
if /i "%INCLUIR_ENV%"=="N" set ENV_OPT=--sem-env

:executar
echo.
echo Gerando backup em "%DESTINO%"...
node src\cli\index.js backup --destino "%DESTINO%" %ENV_OPT%
if errorlevel 1 (
  echo.
  echo [ERRO] O backup falhou.
  if /i not "%~1"=="auto" pause
  exit /b 1
)

if /i "%~1"=="auto" exit /b 0

echo.
echo  OK! Guarde o arquivo em local seguro: ele tem dados de clientes (LGPD).
echo  Para restaurar, veja o LEIA-ME.txt dentro do ZIP.
echo  Sao mantidos os 10 backups mais recentes nesta pasta.
start "" explorer "%DESTINO%"
echo.
pause
