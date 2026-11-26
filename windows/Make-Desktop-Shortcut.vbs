' Puts a Hearth shortcut with its icon on the desktop.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\Hearth.lnk")
lnk.TargetPath = dir & "\Hearth.vbs"
lnk.WorkingDirectory = dir
If fso.FileExists(dir & "\hearth.ico") Then lnk.IconLocation = dir & "\hearth.ico"
lnk.Description = "Hearth - AI on this computer"
lnk.Save
MsgBox "The Hearth shortcut is on your desktop.", 64, "Hearth"
