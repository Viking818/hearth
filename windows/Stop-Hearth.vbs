' Stops Hearth and the model it runs (the same as Settings > Quit).
' With /quiet (the setup program uses it) nothing is shown. The setup also passes the folder Hearth is installed in.
' It asks Hearth to quit on the port it really uses (run.json: Settings' port may be taken, then Hearth picks the
' next free one), waits until it has closed (it stops the model first, which can take a while), at most a minute,
' and then ends whatever of Hearth is still running, so the setup never meets files that are still in use.
On Error Resume Next
quiet = False
folder = ""
For Each a In WScript.Arguments
  If LCase(a) = "/quiet" Then
    quiet = True
  Else
    folder = a
  End If
Next
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
If folder = "" Then folder = fso.GetParentFolderName(WScript.ScriptFullName)
data = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Hearth"

Function NumberIn(file, key)
  On Error Resume Next ' (it applies per procedure)
  NumberIn = 0
  If fso.FileExists(file) Then
    text = fso.OpenTextFile(file, 1).ReadAll()
    Set re = New RegExp
    re.Pattern = """" & key & """\s*:\s*(\d+)"
    Set m = re.Execute(text)
    If m.Count > 0 Then NumberIn = CLng(m(0).SubMatches(0))
  End If
End Function

port = NumberIn(data & "\run.json", "port")
If port = 0 Then port = NumberIn(data & "\settings.json", "port")
If port = 0 Then port = 7420
url = "http://127.0.0.1:" & port

Err.Clear
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "POST", url & "/api/shutdown", False
http.Send
wasRunning = (Err.Number = 0)
Err.Clear
If wasRunning Then
  ' ServerXMLHTTP never answers from a cache, so a failed ping really means Hearth is gone.
  For i = 1 To 120
    Set ping = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    ping.setTimeouts 1000, 1000, 1000, 1000
    ping.Open "GET", url & "/api/ping", False
    ping.Send
    If Err.Number <> 0 Then Exit For
    WScript.Sleep 500
  Next
  Err.Clear
End If

' Whatever is still running: Hearth's own Node.js from its folder, and its engines and tools from its data folder.
ended = 0
Sub EndUnder(dir, onlyName)
  On Error Resume Next ' a process that is gone or not ours is skipped
  Dim wmi, procs, p, exe, prefix
  prefix = LCase(dir)
  If Right(prefix, 1) <> "\" Then prefix = prefix & "\"
  Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
  Set procs = wmi.ExecQuery("Select ProcessId, Name, ExecutablePath From Win32_Process")
  For Each p In procs
    exe = LCase(p.ExecutablePath & "")
    If exe <> "" And Left(exe, Len(prefix)) = prefix And (onlyName = "" Or LCase(p.Name) = onlyName) Then
      p.Terminate
      ended = ended + 1
    End If
  Next
End Sub
EndUnder folder, "node.exe"
EndUnder data, ""
If ended > 0 Then WScript.Sleep 1000

If quiet Then WScript.Quit
If wasRunning Or ended > 0 Then
  MsgBox "Hearth stopped.", 64, "Hearth"
Else
  MsgBox "Hearth is not running.", 64, "Hearth"
End If
