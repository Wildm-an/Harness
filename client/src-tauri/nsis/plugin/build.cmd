@echo off
rem Build the HarnessUI NSIS plugin (harness_ui.c): x86, Unicode, with the MSVC Build Tools.
rem The DLL goes in ..\plugins\x86-unicode. The release workflow builds it again before the installer.
rem The committed DLL is for local builds: a local installer build does not compile it.
rem NSIS_PLUGIN_API: the Examples\Plugin folder of NSIS. The default is the NSIS that Tauri downloads.
setlocal
set HERE=%~dp0
if not defined NSIS_PLUGIN_API set NSIS_PLUGIN_API=%LOCALAPPDATA%\tauri\NSIS\Examples\Plugin
for /f "usebackq delims=" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VS=%%i
if not defined VS (echo The MSVC Build Tools are not installed. & exit /b 1)
call "%VS%\VC\Auxiliary\Build\vcvars32.bat" >nul || exit /b 1
if not exist "%HERE%..\plugins\x86-unicode" mkdir "%HERE%..\plugins\x86-unicode"
if not exist "%HERE%obj" mkdir "%HERE%obj"
cl /nologo /O1 /GS- /W3 /DUNICODE /D_UNICODE /I "%NSIS_PLUGIN_API%" /Fo"%HERE%obj\\" "%HERE%harness_ui.c" ^
  /LD /link /NOLOGO /NODEFAULTLIB:LIBC.lib /OUT:"%HERE%..\plugins\x86-unicode\HarnessUI.dll" /IMPLIB:"%HERE%obj\HarnessUI.lib" ^
  "%NSIS_PLUGIN_API%\nsis\pluginapi-x86-unicode.lib" || exit /b 1
echo Built %HERE%..\plugins\x86-unicode\HarnessUI.dll
