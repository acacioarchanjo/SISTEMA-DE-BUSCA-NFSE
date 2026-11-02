@echo off
setlocal
title Agendar busca diaria - Buscador NFS-e
REM ============================================================
REM  Registra (ou atualiza) a tarefa diaria no Agendador de
REM  Tarefas do Windows, que executa o busca-diaria.bat.
REM ============================================================

cd /d "%~dp0"
set TAREFA=Buscador NFS-e - busca diaria

if /i "%~1"=="remover" goto remover

echo.
echo  Agendar a busca automatica diaria de NFS-e
echo  ------------------------------------------
echo  Para REMOVER o agendamento, rode:  agendar-busca-diaria.bat remover
echo.
set HORA=03:00
set /p HORA=Horario da busca (HH:MM) [03:00]: 

echo %HORA%| findstr /r "^[0-2][0-9]:[0-5][0-9]$" >nul
if errorlevel 1 (
  echo [ERRO] Horario invalido: "%HORA%". Use o formato HH:MM, por exemplo 03:00.
  pause
  exit /b 1
)

schtasks /create /f /tn "%TAREFA%" /sc daily /st %HORA% /rl LIMITED /tr "\"%~dp0busca-diaria.bat\""
if errorlevel 1 (
  echo.
  echo [ERRO] Nao foi possivel criar a tarefa.
  pause
  exit /b 1
)

echo.
echo  OK! A busca vai rodar todo dia as %HORA%.
echo  - O computador precisa estar ligado e com seu usuario conectado nesse horario.
echo  - O resultado fica em: %~dp0data\logs\
echo  - Para conferir ou mudar: abra o "Agendador de Tarefas" e procure "%TAREFA%".
echo.
set /p TESTAR=Quer rodar a busca agora para testar? (S/N) [N]: 
if /i "%TESTAR%"=="S" schtasks /run /tn "%TAREFA%"
echo.
pause
exit /b 0

:remover
schtasks /delete /f /tn "%TAREFA%"
pause
exit /b %ERRORLEVEL%
