@echo off
chcp 65001 >nul
rem Instala o Estúdio de Vozes neste PC: baixa as dependências e cria o atalho na área de trabalho.
rem Precisa do Node.js (https://nodejs.org) instalado.
cd /d "%~dp0.."
where npm >nul 2>nul || (echo Instale o Node.js primeiro: https://nodejs.org & pause & exit /b 1)
echo Baixando as dependencias (uns minutos na primeira vez)...
call npm install --no-fund --no-audit || (echo Falhou o npm install. & pause & exit /b 1)
powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut(\"$d\Estúdio de Vozes.lnk\"); $s.TargetPath=\"$env:WINDIR\System32\wscript.exe\"; $s.Arguments='\"%~dp0Abrir Estudio de Vozes.vbs\"'; $s.WorkingDirectory='%~dp0..'; $s.IconLocation='%~dp0..\node_modules\electron\dist\electron.exe,0'; $s.Save()"
echo.
echo Pronto! Abra pelo atalho "Estúdio de Vozes" na area de trabalho.
pause
