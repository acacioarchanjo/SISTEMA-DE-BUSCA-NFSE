@echo off
setlocal
title Restaurar backup - Buscador NFS-e
REM ============================================================
REM  Restaura um backup gerado pelo backup-dados.bat.
REM
REM  Uso:
REM    - duplo clique: escolhe um backup da pasta "backups"
REM    - arraste um backup .zip para cima deste arquivo
REM
REM  Seguranca: nada e apagado. A pasta "data" e o ".env" atuais
REM  sao guardados como "...-antes-restauracao-<data>". Se algo
REM  der errado no meio, tudo volta como estava.
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo [ERRO] Dependencias nao instaladas. Rode o iniciar.bat uma vez antes.
  pause
  exit /b 1
)
if not exist ".env" (
  echo NFSE_MASTER_KEY=>".env"
)

echo.
echo  Restaurar backup do Buscador NFS-e
echo  ----------------------------------
echo  ANTES DE CONTINUAR: clique em "Encerrar" no painel ^(ou feche a janela do iniciar.bat^)
echo  e verifique se a busca agendada nao esta rodando agora.
echo.

set BACKUP=%~1
if not "%BACKUP%"=="" goto confirmar

node src\cli\index.js backups
echo.
echo  Digite o NUMERO do backup acima, ou cole o caminho completo de um .zip
echo  (por exemplo E:\Backups\backup-nfse-2026-03-31_030000.zip).
set /p BACKUP=Backup [1]: 
if "%BACKUP%"=="" set BACKUP=1

:confirmar
echo.
node src\cli\index.js restaurar "%BACKUP%"
if errorlevel 3 goto erro
if not errorlevel 2 goto erro
echo.
echo  Os dados ATUAIS serao substituidos pelos dados deste backup.
echo  (os atuais ficam guardados em "data-antes-restauracao-...")
set CONFIRMA=
set /p CONFIRMA=Digite SIM para restaurar: 
if /i not "%CONFIRMA%"=="SIM" (
  echo Cancelado. Nada foi alterado.
  pause
  exit /b 0
)

echo.
node src\cli\index.js restaurar "%BACKUP%" --sim
if errorlevel 3 (
  echo.
  echo  Restaurado, mas ATENCAO ao aviso acima sobre a chave dos certificados.
  pause
  exit /b 3
)
if errorlevel 1 goto erro

echo.
echo  OK! Backup restaurado. Abra o iniciar.bat para usar o sistema.
echo  Depois de conferir, voce pode apagar as pastas "data-antes-restauracao-...".
echo.
pause
exit /b 0

:erro
echo.
echo [ERRO] Nao foi possivel restaurar. Veja a mensagem acima.
echo        Seus dados atuais nao foram alterados.
pause
exit /b 1
