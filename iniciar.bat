@echo off
setlocal
title Buscador NFS-e
REM ============================================================
REM  Buscador NFS-e - inicializador para Windows
REM  Duplo clique neste arquivo para subir o painel.
REM ============================================================

REM Vai para a pasta onde este .bat esta (funciona de qualquer lugar)
cd /d "%~dp0"

echo.
echo  ==========================================
echo    Buscador NFS-e - iniciando...
echo  ==========================================
echo.

REM 1) Node.js instalado?
where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado.
  echo        Instale a versao LTS em https://nodejs.org e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

REM 2) Versao minima 22
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo [ERRO] Node.js %NODE_MAJOR% e antigo demais. Instale o Node LTS em https://nodejs.org
  echo.
  pause
  exit /b 1
)

REM 3) Dependencias: instala na primeira vez ou se a instalacao estiver incompleta
node -e "require('dotenv');require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  echo Instalando dependencias - pode demorar alguns minutos...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERRO] Falha no npm install. Veja a secao "Problemas comuns" do README.
    pause
    exit /b 1
  )
  node -e "require('dotenv');require('better-sqlite3')"
  if errorlevel 1 (
    echo.
    echo [ERRO] As dependencias nao carregaram mesmo apos o npm install. Mande a mensagem acima para o suporte.
    pause
    exit /b 1
  )
)

REM 4) Arquivo .env com chave mestra (criado automaticamente na primeira vez)
if not exist ".env" (
  echo Criando arquivo .env a partir do .env.example...
  copy /y ".env.example" ".env" >nul
)
node -e "const fs=require('fs');let s=fs.readFileSync('.env','utf8');if(/^NFSE_MASTER_KEY=COLE_AQUI/m.test(s)){const k=require('crypto').randomBytes(32).toString('base64');s=s.replace(/^NFSE_MASTER_KEY=.*$/m,'NFSE_MASTER_KEY='+k);fs.writeFileSync('.env',s);console.log('NOVA_CHAVE');}" > "%TEMP%\nfse_chave.txt"
findstr /c:"NOVA_CHAVE" "%TEMP%\nfse_chave.txt" >nul
if not errorlevel 1 (
  echo.
  echo  ************************************************************
  echo   Uma chave de criptografia nova foi gerada no arquivo .env
  echo   ^(NFSE_MASTER_KEY^). FACA BACKUP DO .env EM LOCAL SEGURO:
  echo   sem essa chave os certificados salvos nao podem ser lidos.
  echo  ************************************************************
  echo.
)
del "%TEMP%\nfse_chave.txt" >nul 2>nul

REM 5) Porta configurada no .env (padrao 3000)
set PORTA=3000
for /f "tokens=2 delims==" %%p in ('findstr /b /c:"NFSE_SERVER_PORT=" .env') do set PORTA=%%p

REM 6) Se o sistema ja esta aberto, so abre o navegador
node -e "const s=require('net').connect(%PORTA%,'127.0.0.1');s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),800)"
if errorlevel 1 (
  echo O sistema ja esta aberto. Abrindo o painel no navegador...
  start "" "http://127.0.0.1:%PORTA%"
  exit /b 0
)

REM 7) Sobe o servidor e abre o navegador assim que ele responder
echo Abrindo o painel em http://127.0.0.1:%PORTA%
echo Para encerrar o sistema, feche esta janela ou aperte Ctrl+C.
echo.
start "" /b node src\util\abrir-navegador.js %PORTA%
call npm.cmd start

echo.
echo O sistema foi encerrado.
pause
