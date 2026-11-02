@echo off
setlocal
REM ============================================================
REM  Buscador NFS-e - busca automatica (todas as empresas ativas)
REM  Feito para rodar pelo Agendador de Tarefas do Windows.
REM  Use "agendar-busca-diaria.bat" para registrar o horario.
REM  Tambem pode ser executado manualmente com duplo clique.
REM ============================================================

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERRO] Node.js nao encontrado. Instale em https://nodejs.org
  exit /b 1
)
if not exist "node_modules\" (
  echo [ERRO] Dependencias nao instaladas. Rode o iniciar.bat uma vez antes.
  exit /b 1
)
if not exist ".env" (
  echo [ERRO] Arquivo .env nao encontrado. Rode o iniciar.bat uma vez antes.
  exit /b 1
)

REM Log do dia em data\logs\busca-AAAA-MM-DD.log
if not exist "data\logs\" mkdir "data\logs"
for /f %%d in ('node -p "new Date().toLocaleDateString('sv')"') do set HOJE=%%d
set LOG=data\logs\busca-%HOJE%.log

echo ==== %DATE% %TIME% - inicio da busca ====>> "%LOG%"
node src\cli\index.js buscar >> "%LOG%" 2>&1
set RESULTADO=%ERRORLEVEL%
echo ==== %DATE% %TIME% - fim (codigo %RESULTADO%) ====>> "%LOG%"
echo.>> "%LOG%"

REM Apaga logs com mais de 90 dias
forfiles /p "data\logs" /m busca-*.log /d -90 /c "cmd /c del @path" >nul 2>nul

type "%LOG%"
exit /b %RESULTADO%
