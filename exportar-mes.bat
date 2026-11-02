@echo off
setlocal
title Exportar notas do mes - Buscador NFS-e
REM ============================================================
REM  Exporta as NFS-e de um mes (competencia) em ZIP:
REM  XMLs organizados por empresa/emitidas/recebidas + planilha CSV
REM  (opcional: PDF de cada nota). Saida na pasta "exportacoes".
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
  echo [ERRO] Arquivo .env nao encontrado. Rode o iniciar.bat uma vez antes.
  pause
  exit /b 1
)

echo.
echo  Exportar notas do mes
echo  ---------------------
echo.

REM Mes padrao = mes anterior
for /f %%m in ('node -p "const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);d.toLocaleDateString('sv').slice(0,7)"') do set MES_PADRAO=%%m
set MES=%MES_PADRAO%
set /p MES=Mes de competencia (AAAA-MM) [%MES_PADRAO%]: 
echo %MES%| findstr /r "^20[0-9][0-9]-[01][0-9]$" >nul
if errorlevel 1 (
  echo [ERRO] Mes invalido: "%MES%". Use AAAA-MM, por exemplo %MES_PADRAO%.
  pause
  exit /b 1
)

echo.
node src\cli\index.js empresas
echo.
set EMPRESA=
set /p EMPRESA=Empresa (id ou CNPJ; Enter = todas): 

set PDF=N
set /p PDF=Incluir PDF de cada nota? (S/N) [N]: 

set ARGS=exportar --mes %MES%
set NOME=nfse-%MES%
if "%EMPRESA%"=="" goto sem_empresa
REM tira pontos, barra e traco do CNPJ para usar no nome do arquivo
set EMP_ARQ=%EMPRESA:.=%
set EMP_ARQ=%EMP_ARQ:/=%
set EMP_ARQ=%EMP_ARQ:-=%
set ARGS=%ARGS% --empresa %EMPRESA%
set NOME=%NOME%-empresa-%EMP_ARQ%
:sem_empresa
if /i "%PDF%"=="S" set ARGS=%ARGS% --pdf
set SAIDA=exportacoes\%NOME%.zip

if exist "%SAIDA%" del "%SAIDA%"
echo.
echo Gerando exportacao...
node src\cli\index.js %ARGS% --saida "%SAIDA%"
if errorlevel 1 (
  echo.
  echo [ERRO] A exportacao falhou.
  pause
  exit /b 1
)

if exist "%SAIDA%" (
  echo.
  echo  OK! Arquivo gerado: %~dp0%SAIDA%
  echo  Dentro do ZIP: XMLs por empresa/emitidas/recebidas/mes e a planilha-nfse.csv
  explorer /select,"%~dp0%SAIDA%"
) else (
  echo.
  echo  Nenhuma nota encontrada para %MES%. Rode uma busca antes, se necessario.
)
echo.
pause
