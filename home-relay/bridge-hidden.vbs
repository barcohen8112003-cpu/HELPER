' HELPER PC bridge launcher. No console window.
' The scheduled task "HELPER PC Bridge" runs this at logon, in the signed-in user session.
' Window style 0 hides the process. The last argument True waits, so the task stays
' running for as long as the bridge service does. wscript itself has no console.
Option Explicit
Dim fso, sh, dir, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(dir, "bridge-service.ps1")
sh.CurrentDirectory = fso.GetParentFolderName(dir)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, True
