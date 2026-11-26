' Starts Hearth without a console window and opens it (Microsoft Edge shows it as an app).
' Double-click this file. Hearth keeps running in the background; use Stop-Hearth.vbs or Settings > Quit to stop it.
' With /background (how Windows starts it at sign-in when Settings > This computer > Start with Windows is on), no
' window opens: Hearth and its bots just run, and the Hearth icon opens the window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir & "\app"
openArg = " --open"
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "/background" Then openArg = ""
End If
sh.Run """" & dir & "\node\node.exe"" server\index.mjs" & openArg, 0, False
