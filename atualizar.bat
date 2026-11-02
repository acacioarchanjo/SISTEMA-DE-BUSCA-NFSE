@echo off
setlocal
REM ============================================================
REM  Buscador NFS-e - atualizador
REM  Baixa a versao mais recente do GitHub e atualiza o sistema,
REM  SEM mexer nos seus dados (data, backups, exportacoes, .env).
REM
REM  Passos: 1) confere se o painel esta fechado
REM          2) faz um backup automatico dos dados
REM          3) baixa e copia a versao nova (git pull ou ZIP)
REM          4) atualiza as dependencias (npm install)
REM          5) testa se o sistema abre
REM ============================================================

REM Este .bat pode ser substituido pela versao nova durante a
REM atualizacao; por isso ele roda a partir de uma copia no %TEMP%.
if /i "%~1"=="--copia" goto inicio
copy /y "%~f0" "%TEMP%\buscador-nfse-atualizar.bat" >nul
"%TEMP%\buscador-nfse-atualizar.bat" --copia "%~dp0."
exit /b %ERRORLEVEL%

:inicio
title Atualizar - Buscador NFS-e
set "PROJETO=%~f2"
cd /d "%PROJETO%"
set REPO=acacioarchanjo/SISTEMA-DE-BUSCA-NFSE
set "TMPDIR=%TEMP%\buscador-nfse-atualizacao"

echo.
echo  ==========================================
echo    Atualizar o Buscador NFS-e
echo  ==========================================
echo  Pasta: %PROJETO%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  goto falha
)

REM ---- 1) Painel precisa estar fechado (arquivos em uso no Windows) ----
set PORTA=3000
if exist ".env" for /f "tokens=2 delims==" %%p in ('findstr /b /c:"NFSE_SERVER_PORT=" .env') do set PORTA=%%p
node -e "const s=require('net').connect(%PORTA%,'127.0.0.1');s.on('connect',()=>process.exit(1));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),800)"
if errorlevel 1 (
  echo [ERRO] O sistema esta aberto. Clique em "Encerrar" no painel ^(ou feche a janela do iniciar.bat^) e rode de novo.
  goto falha
)

REM ---- Versao atual x versao no GitHub ----
set VERSAO_ATUAL=
if exist ".versao" set /p VERSAO_ATUAL=<".versao"
set VERSAO_NOVA=
for /f %%v in ('powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; try { (Invoke-WebRequest -UseBasicParsing -Headers @{Accept='application/vnd.github.sha'} -Uri 'https://api.github.com/repos/%REPO%/commits/main').Content } catch { '' }"') do set VERSAO_NOVA=%%v
if "%VERSAO_NOVA%"=="" (
  echo [AVISO] Nao foi possivel consultar a versao no GitHub. Tentando atualizar mesmo assim...
) else (
  echo Versao instalada: %VERSAO_ATUAL%
  echo Versao no GitHub: %VERSAO_NOVA%
)
if not "%VERSAO_NOVA%"=="" if "%VERSAO_NOVA%"=="%VERSAO_ATUAL%" (
  echo.
  echo  O sistema ja esta na versao mais recente. Nada a fazer.
  goto fim_ok
)

REM ---- 2) Backup automatico antes de atualizar ----
REM (se as dependencias estao quebradas, o sistema nunca rodou: nao ha o que salvar)
node -e "require('dotenv');require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  echo [AVISO] Instalacao atual incompleta - pulando o backup automatico.
  goto baixar
)
if exist ".env" (
  echo.
  echo Fazendo backup dos dados antes de atualizar...
  node src\cli\index.js backup
  if errorlevel 1 (
    echo [ERRO] O backup falhou; a atualizacao foi cancelada para proteger seus dados.
    goto falha
  )
)

REM ---- 3) Baixa a versao nova ----
:baixar
echo.
if exist ".git\" (
  where git >nul 2>nul
  if not errorlevel 1 goto via_git
)

echo Baixando a versao mais recente do GitHub...
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/%REPO%/archive/refs/heads/main.zip' -OutFile '%TMPDIR%\main.zip'"
if errorlevel 1 (
  echo [ERRO] Falha no download. Verifique a internet e tente de novo.
  goto falha
)
powershell -NoProfile -Command "Expand-Archive -Force -Path '%TMPDIR%\main.zip' -DestinationPath '%TMPDIR%\extraido'"
if errorlevel 1 (
  echo [ERRO] Falha ao descompactar a atualizacao.
  goto falha
)
set "ORIGEM="
for /d %%d in ("%TMPDIR%\extraido\*") do set "ORIGEM=%%d"
if not exist "%ORIGEM%\package.json" (
  echo [ERRO] O pacote baixado nao parece ser o Buscador NFS-e.
  goto falha
)

echo Copiando os arquivos novos (seus dados nao sao tocados)...
robocopy "%ORIGEM%" "%PROJETO%" /E /XD data backups exportacoes node_modules .git data-antes-restauracao-* /XF .env .env.antes-restauracao-* .versao /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [ERRO] Falha ao copiar os arquivos. Nenhum dado foi apagado; rode de novo.
  goto falha
)
rmdir /s /q "%TMPDIR%" >nul 2>nul
goto dependencias

:via_git
echo Atualizando pelo Git...
git pull --ff-only origin main
if errorlevel 1 (
  echo [ERRO] O "git pull" falhou. Se voce alterou arquivos do sistema, desfaca as alteracoes e tente de novo.
  goto falha
)

:dependencias
REM ---- 4) Dependencias ----
echo.
echo Atualizando dependencias (npm install)...
call npm.cmd install --no-audit --no-fund
if errorlevel 1 (
  echo [ERRO] Falha no npm install. Veja a secao "Problemas comuns" do README.
  goto falha
)

REM ---- 5) Teste rapido ----
node src\cli\index.js empresas >nul
if errorlevel 1 (
  echo [ERRO] O sistema atualizado nao abriu. Seus dados estao no backup em "backups".
  goto falha
)

if not "%VERSAO_NOVA%"=="" (echo %VERSAO_NOVA%)>".versao"
echo.
echo  OK! Sistema atualizado. Abra o iniciar.bat para usar.
goto fim_ok

:falha
echo.
pause
exit /b 1

:fim_ok
echo.
pause
exit /b 0
