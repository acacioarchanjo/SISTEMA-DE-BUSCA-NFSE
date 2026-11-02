@echo off
setlocal
title Criar atalho - Buscador NFS-e
REM ============================================================
REM  Cria o atalho "Buscador NFS-e" (com icone) na Area de
REM  Trabalho e no Menu Iniciar. O atalho abre o sistema em
REM  SEGUNDO PLANO (sem janela preta) e abre o navegador sozinho.
REM  Para fechar o sistema: botao "Encerrar" no painel.
REM  Rode de novo se mudar a pasta do sistema de lugar.
REM ============================================================

cd /d "%~dp0"

if not exist "abrir.vbs" (
  echo [ERRO] Coloque este arquivo na pasta do sistema, ao lado do abrir.vbs.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pasta = (Get-Location).Path;" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$destinos = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'));" ^
  "foreach ($d in $destinos) {" ^
  "  $lnk = $ws.CreateShortcut((Join-Path $d 'Buscador NFS-e.lnk'));" ^
  "  $lnk.TargetPath = (Join-Path $env:WINDIR 'System32\wscript.exe');" ^
  "  $lnk.Arguments = [char]34 + (Join-Path $pasta 'abrir.vbs') + [char]34;" ^
  "  $lnk.WorkingDirectory = $pasta;" ^
  "  $lnk.IconLocation = (Join-Path $pasta 'assets\icone.ico') + ',0';" ^
  "  $lnk.Description = 'Abrir o Buscador NFS-e';" ^
  "  $lnk.Save();" ^
  "  Write-Host ('  Atalho criado em: ' + $d)" ^
  "}"
if errorlevel 1 (
  echo.
  echo [ERRO] Nao foi possivel criar o atalho.
  pause
  exit /b 1
)

echo.
echo  OK! Agora e so dar duplo clique em "Buscador NFS-e" na Area de Trabalho
echo  ^(ou procurar "Buscador NFS-e" no Menu Iniciar^).
echo.
echo  - O sistema roda em segundo plano, sem janela preta.
echo  - Para ENCERRAR o sistema, clique em "Encerrar" no canto do painel.
echo  - Se o sistema ja estiver aberto, o atalho so abre o painel no navegador.
echo  - Se der problema, veja data\logs\servidor.log ou abra o iniciar.bat.
echo.
pause
