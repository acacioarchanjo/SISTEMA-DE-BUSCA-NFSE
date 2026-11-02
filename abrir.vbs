' ============================================================
'  Buscador NFS-e - abre o sistema SEM janela preta.
'  O servidor roda em segundo plano; para fechar, use o botao
'  "Encerrar" no painel. O atalho da Area de Trabalho usa este
'  arquivo (crie com o criar-atalho.bat).
'  Registro do servidor: data\logs\servidor.log
' ============================================================
Option Explicit
Dim fso, sh, pasta, porta, linha, arq, url, ret, logDir

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = pasta

' Primeira vez (sem dependencias ou sem .env): usa o iniciar.bat com janela,
' para mostrar a instalacao e possiveis erros.
If Not fso.FileExists(pasta & "\.env") Or Not fso.FolderExists(pasta & "\node_modules\better-sqlite3") Then
  sh.Run "cmd /c """ & pasta & "\iniciar.bat""", 1, False
  WScript.Quit 0
End If

' Node instalado?
If sh.Run("cmd /c where node", 0, True) <> 0 Then
  MsgBox "Node.js nao encontrado. Instale em https://nodejs.org", vbCritical, "Buscador NFS-e"
  WScript.Quit 1
End If

' Porta do .env (padrao 3000)
porta = "3000"
Set arq = fso.OpenTextFile(pasta & "\.env", 1)
Do Until arq.AtEndOfStream
  linha = Trim(arq.ReadLine)
  If Left(linha, 17) = "NFSE_SERVER_PORT=" Then porta = Trim(Mid(linha, 18))
Loop
arq.Close
url = "http://127.0.0.1:" & porta

' Ja esta aberto? Entao so abre o navegador (espera no maximo 2 s).
If sh.Run("node src\util\abrir-navegador.js " & porta & " 2", 0, True) = 0 Then WScript.Quit 0

' Sobe o servidor escondido, gravando o registro em data\logs\servidor.log
logDir = pasta & "\data\logs"
If Not fso.FolderExists(pasta & "\data") Then fso.CreateFolder pasta & "\data"
If Not fso.FolderExists(logDir) Then fso.CreateFolder logDir
sh.Run "cmd /c node src\server\index.js >> ""data\logs\servidor.log"" 2>&1", 0, False

' Espera ate 60 s o painel responder e abre o navegador
ret = sh.Run("node src\util\abrir-navegador.js " & porta & " 60", 0, True)
If ret <> 0 Then
  MsgBox "O sistema nao respondeu." & vbCrLf & vbCrLf & _
         "Veja o registro em:" & vbCrLf & logDir & "\servidor.log" & vbCrLf & vbCrLf & _
         "Ou abra o iniciar.bat para ver a mensagem de erro.", vbExclamation, "Buscador NFS-e"
  WScript.Quit 1
End If
