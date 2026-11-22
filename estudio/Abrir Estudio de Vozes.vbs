' Abre o Estúdio de Vozes sem janela preta (usa o Electron do repositório)
Set fso = CreateObject("Scripting.FileSystemObject")
raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = raiz
sh.Run """" & raiz & "\node_modules\electron\dist\electron.exe"" estudio", 0, False
