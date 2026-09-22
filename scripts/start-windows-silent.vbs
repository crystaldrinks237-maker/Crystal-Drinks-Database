' Runs start-windows.bat silently (no black terminal window) at login.
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
objShell.Run """" & objShell.CurrentDirectory & "\start-windows.bat""", 0, False
