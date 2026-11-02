@echo off
setlocal
title Acesso pela rede - Buscador NFS-e
REM ============================================================
REM  Liga ou desliga o acesso ao sistema pelos outros computadores
REM  do escritorio (mesma rede). Com o acesso ligado, todos entram
REM  com login e senha. Precisa de permissao de administrador do
REM  Windows (para a regra do Firewall).
REM ============================================================

cd /d "%~dp0"

REM Pede permissao de administrador (UAC) se ainda nao tiver
net session >nul 2>nul
if errorlevel 1 (
  echo Pedindo permissao de administrador do Windows...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)
if not exist ".env" (
  echo [ERRO] Arquivo .env nao encontrado. Rode o iniciar.bat uma vez antes.
  pause
  exit /b 1
)

REM Porta configurada no .env (padrao 3000)
set PORTA=3000
for /f "tokens=2 delims==" %%p in ('findstr /b /c:"NFSE_SERVER_PORT=" .env 2^>nul') do set PORTA=%%p
if "%PORTA%"=="" set PORTA=3000

echo.
echo  Acesso pela rede do escritorio
echo  ------------------------------
echo   1 = LIGAR   (outros computadores da rede acessam, com login e senha)
echo   2 = DESLIGAR (so este computador acessa)
echo.
set OPCAO=
set /p OPCAO=Escolha (1/2): 

if "%OPCAO%"=="1" goto ligar
if "%OPCAO%"=="2" goto desligar
echo Opcao invalida.
pause
exit /b 1

:ligar
node -e "const fs=require('fs');let t=fs.readFileSync('.env','utf8');if(/^NFSE_SERVER_HOST=.*$/m.test(t))t=t.replace(/^NFSE_SERVER_HOST=.*$/m,'NFSE_SERVER_HOST=0.0.0.0');else t=t.replace(/\s*$/,'\r\nNFSE_SERVER_HOST=0.0.0.0\r\n');fs.writeFileSync('.env',t)"
if errorlevel 1 goto erro_env
netsh advfirewall firewall delete rule name="Buscador NFS-e" >nul 2>nul
REM so redes privadas/dominio e so a sub-rede local (nunca a internet)
netsh advfirewall firewall add rule name="Buscador NFS-e" dir=in action=allow protocol=TCP localport=%PORTA% profile=private,domain remoteip=localsubnet >nul
if errorlevel 1 (
  echo [AVISO] Nao foi possivel criar a regra do Firewall. Libere a porta %PORTA% manualmente.
)
echo.
echo  OK! Acesso pela rede LIGADO.
echo.
echo  1) Se ainda nao fez: abra o sistema NESTE computador e crie o
echo     administrador e os usuarios (botao "Usuarios", na barra lateral).
echo  2) Clique em "Encerrar" no painel e abra o sistema de novo.
echo  3) Nos outros computadores, abra no navegador:
node -e "const os=require('os');for(const l of Object.values(os.networkInterfaces()))for(const i of l||[])if(i.family==='IPv4'&&!i.internal)console.log('       http://'+i.address+':%PORTA%')"
echo.
echo  A rede do Windows precisa estar como "Rede privada" (nao "Publica").
echo.
pause
exit /b 0

:desligar
node -e "const fs=require('fs');let t=fs.readFileSync('.env','utf8');t=t.replace(/^NFSE_SERVER_HOST=.*$/m,'NFSE_SERVER_HOST=127.0.0.1');fs.writeFileSync('.env',t)"
if errorlevel 1 goto erro_env
netsh advfirewall firewall delete rule name="Buscador NFS-e" >nul 2>nul
echo.
echo  OK! Acesso pela rede DESLIGADO: so este computador acessa.
echo  Clique em "Encerrar" no painel e abra o sistema de novo.
echo.
pause
exit /b 0

:erro_env
echo [ERRO] Nao foi possivel alterar o arquivo .env.
pause
exit /b 1
