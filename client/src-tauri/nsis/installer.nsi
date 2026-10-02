; The NSIS template of the Harness installer.
;
; It is the template of Tauri 2.12.0 (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi),
; with these changes. The lines for them start with "Harness".
; - One click: the first page has an Install button. There is no page for the folder, and no page
;   for an installed version: the install goes over it. The finish page asks for a desktop
;   shortcut and to launch the app now.
; - The installer and the uninstaller have the color of the Harness sidebar, with the logo in the
;   middle. The title bar has the same color, with no title and no icon. The install page shows the
;   loading bar under the logo, with no buttons.
; - The buttons are text with a highlight on hover (the HarnessUI plugin, nsis/plugin).
; - No copyright or license text at the bottom.
; After an update of the Tauri CLI, compare this file with the new template.

Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "Win\RestartManager.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

Name "${PRODUCTNAME}"
BrandingText " " ; Harness: no copyright or license text at the bottom.
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"


; ---------- Harness: an installer with the color of the sidebar, and the logo in the middle ----------
;
; - All pages have the color of the Harness sidebar (#1f1e1d), with light text. The title bar has
;   the same color, with no title and no icon: only the window buttons show.
; - The buttons are text. They show a highlight when the pointer is on them (the HarnessUI plugin).
; - The welcome page and the finish page show the logo in the middle, and the text under it.
; - The other pages show the logo and the name in the middle of the header.
; - The install page shows the logo in the middle, the loading bar under it, and then the status:
;   the percentage ("37%"), "Installing Harness 0.1.20", "Name: harness-daemon.exe... 37%" (NSIS
;   updates it during the copy of a file), and the folder.
; The images are in nsis/brand (make_images.py), one for each display scale of Windows.

; The colors of the dark theme of Harness (client/src/styles.css): --sidebar, --text, --text-muted,
; --surface, --hover on the sidebar, and --surface-2.
!define HARNESS_BG 0x1F1E1D
!define HARNESS_BG_COLORREF 0x001D1E1F ; The same color for Windows APIs: 0x00BBGGRR.
!define HARNESS_TEXT 0xFAF9F5
!define HARNESS_MUTED 0xA8A59C
!define HARNESS_FIELD 0x30302E
!define HARNESS_HOVER 0x2C2B2A
!define HARNESS_PRESSED 0x3A3A37
!define MUI_BGCOLOR 1F1E1D
!define MUI_TEXTCOLOR FAF9F5
!define MUI_CUSTOMFUNCTION_GUIINIT HarnessGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.HarnessGuiInit
!searchreplace HARNESS_BRAND "${HEADERIMAGE}" "header.bmp" "brand"
; The HarnessUI plugin is in nsis/plugins (nsis/plugin/build.cmd builds it).
!searchreplace HARNESS_PLUGINS "${HEADERIMAGE}" "header.bmp" "plugins\x86-unicode"
!addplugindir "${HARNESS_PLUGINS}"

Var HarnessPage
Var HarnessScale ; The display scale in percent: 100, 125, 150, 175, or 200.
Var HarnessHeader ; The logo and the name in the header.
Var HarnessStatus
Var HarnessPercent ; The percentage under the loading bar of the install page.
Var HarnessBigFont
Var HarnessOneClick ; 1: the page for an installed version does not show.
Var HarnessDirText ; The install folder on the first page.
Var HarnessDirLabel

!macro HarnessBrandFile SCALE
  File "/oname=$PLUGINSDIR\harness-logo-${SCALE}.bmp" "${HARNESS_BRAND}\logo-${SCALE}.bmp"
  File "/oname=$PLUGINSDIR\harness-header-${SCALE}.bmp" "${HARNESS_BRAND}\header-${SCALE}.bmp"
!macroend

; One file is copied: show the new percentage under the loading bar.
!macro HarnessItemDone
  Call HarnessShowPercent
!macroend

!macro HARNESS_FUNCTIONS UN
Function ${UN}HarnessScale
  System::Call "user32::GetDpiForWindow(p $HWNDPARENT) i .r9"
  ${If} $9 < 1 ; Windows before 10 (1607).
    StrCpy $9 96
  ${EndIf}
  IntOp $9 $9 * 100
  IntOp $9 $9 / 96
  ${If} $9 < 113
    StrCpy $HarnessScale 100
  ${ElseIf} $9 < 138
    StrCpy $HarnessScale 125
  ${ElseIf} $9 < 163
    StrCpy $HarnessScale 150
  ${ElseIf} $9 < 188
    StrCpy $HarnessScale 175
  ${Else}
    StrCpy $HarnessScale 200
  ${EndIf}
FunctionEnd

; In: $0 a number of pixels at 100 %. Out: $0 for the display scale.
Function ${UN}HarnessPx
  IntOp $0 $0 * $HarnessScale
  IntOp $0 $0 / 100
FunctionEnd

; In: $R9 a window. Out: $8 the width of its client area, in pixels.
Function ${UN}HarnessWidth
  System::Call "*(i, i, i, i) p .r9"
  System::Call "user32::GetClientRect(p R9, p r9)"
  System::Call "*$9(i, i, i .r8, i)"
  System::Free $9
FunctionEnd

; On the dark page, the lines under the header and above the buttons are not needed, and the
; header shows the logo in place of the title of the page. MUI shows these controls again when a
; page shows, so each page calls this function.
Function ${UN}HarnessHideLines
  GetDlgItem $0 $HWNDPARENT 1035 ; The line above the buttons, on a page with a header.
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1036 ; The line under the header.
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1045 ; The line above the buttons, on the welcome page and the finish page.
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1037 ; The title of the page, for example "Installing".
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1038 ; The text under it, for example "Please wait while Harness is being installed."
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039 ; The header image of MUI.
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

; The last button of a page (Finish, Close): Next (1) goes to the place of Cancel (2), at the far
; right. Cancel is hidden on these pages.
Function ${UN}HarnessNextFarRight
  GetDlgItem $1 $HWNDPARENT 1
  GetDlgItem $2 $HWNDPARENT 2
  System::Call "*(i, i, i, i) p .r9"
  System::Call "user32::GetWindowRect(p r2, p r9)"
  System::Call "user32::MapWindowPoints(p 0, p $HWNDPARENT, p r9, i 2)"
  System::Call "*$9(i .r3, i .r4, i .r5, i .r6)"
  System::Free $9
  IntOp $5 $5 - $3
  IntOp $6 $6 - $4
  System::Call "user32::SetWindowPos(p r1, p 0, i r3, i r4, i r5, i r6, i 0x14)" ; SWP_NOZORDER | SWP_NOACTIVATE
  ShowWindow $1 ${SW_SHOW}
FunctionEnd

; Hide or show the buttons at the bottom: Next (1), Cancel (2), and Back (3).
Function ${UN}HarnessHideButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

; After an error, the user must be able to close the window: show Next ("Close") and Cancel.
Function ${UN}HarnessShowCloseButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_SHOW}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_SHOW}
FunctionEnd

; In: $R9 a window, and its child controls: they get the dark colors.
Function ${UN}HarnessDark
  SetCtlColors $R9 ${HARNESS_TEXT} ${HARNESS_BG}
  StrCpy $R8 0
  next:
    FindWindow $R8 "" "" $R9 $R8
    StrCmp $R8 0 done
    System::Call "user32::GetClassName(p R8, t .R7, i 64)"
    StrCmp $R7 "Button" button
    StrCmp $R7 "Edit" edit
    StrCmp $R7 "Static" static
    StrCmp $R7 "msctls_progress32" progress
    Goto next
  button:
    System::Call "user32::GetWindowLong(p R8, i -16) i .R6"
    IntOp $R6 $R6 & 0xF
    IntCmp $R6 1 push push
    ; A check box, a radio button, or a group box: with no theme, the text color applies.
    System::Call 'uxtheme::SetWindowTheme(p R8, w "", w "")'
    SetCtlColors $R8 ${HARNESS_TEXT} ${HARNESS_BG}
    Goto next
  push:
    HarnessUI::TextButton $R8
    Goto next
  edit:
    System::Call 'uxtheme::SetWindowTheme(p R8, w "DarkMode_Explorer", p 0)'
    SetCtlColors $R8 ${HARNESS_TEXT} ${HARNESS_FIELD}
    Goto next
  static:
    SetCtlColors $R8 ${HARNESS_TEXT} ${HARNESS_BG}
    Goto next
  progress:
    ; With no theme, the bar colors apply: the accent color of the app on dark gray.
    System::Call 'uxtheme::SetWindowTheme(p R8, w "", w "")'
    SendMessage $R8 0x409 0 0x003F61C6 ; PBM_SETBARCOLOR: RGB(198, 97, 63)
    SendMessage $R8 0x2001 0 0x002E3030 ; PBM_SETBKCOLOR: RGB(48, 48, 46), --surface
    Goto next
  done:
FunctionEnd

; In: $R9 the parent, $R5 "logo" or "header", $R6 the width and $R7 the height at 100 %, $R8 the
; top at 100 %. It shows the image in the middle of the parent. Out: $R4 the image control.
Function ${UN}HarnessPicture
  StrCpy $0 $R6
  Call ${UN}HarnessPx
  StrCpy $R6 $0
  StrCpy $0 $R7
  Call ${UN}HarnessPx
  StrCpy $R7 $0
  StrCpy $0 $R8
  Call ${UN}HarnessPx
  StrCpy $R8 $0
  Call ${UN}HarnessWidth
  IntOp $8 $8 - $R6
  IntOp $8 $8 / 2
  ; WS_CHILD | WS_VISIBLE | SS_BITMAP
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t "", i 0x5000000E, i r8, i R8, i R6, i R7, p R9, p 0, p 0, p 0) p .R4'
  System::Call 'user32::LoadImage(p 0, t "$PLUGINSDIR\harness-$R5-$HarnessScale.bmp", i 0, i 0, i 0, i 0x10) p .r9'
  SendMessage $R4 0x172 0 $9 ; STM_SETIMAGE, IMAGE_BITMAP
FunctionEnd

; In: $0 a control of $HarnessPage, $R1 its top and $R3 its height at 100 %, $R2 its width at
; 100 % (0: the width of the page, less the margins). It goes in the middle, with its text centered.
Function ${UN}HarnessCenter
  StrCpy $R5 $0
  StrCpy $R9 $HarnessPage
  Call ${UN}HarnessWidth
  ${If} $R2 = 0
    StrCpy $0 32
    Call ${UN}HarnessPx
    IntOp $R2 $8 - $0
    IntOp $R2 $R2 - $0
  ${Else}
    StrCpy $0 $R2
    Call ${UN}HarnessPx
    StrCpy $R2 $0
  ${EndIf}
  IntOp $R0 $8 - $R2
  IntOp $R0 $R0 / 2
  StrCpy $0 $R1
  Call ${UN}HarnessPx
  StrCpy $R1 $0
  StrCpy $0 $R3
  Call ${UN}HarnessPx
  StrCpy $R3 $0
  StrCpy $0 $R5
  System::Call "user32::SetWindowPos(p r0, p 0, i R0, i R1, i R2, i R3, i 0x14)" ; SWP_NOZORDER | SWP_NOACTIVATE
  System::Call "user32::GetClassName(p r0, t .r9, i 64)"
  ${If} $9 == "Static"
    System::Call "user32::GetWindowLong(p r0, i -16) i .r9"
    IntOp $9 $9 & 0xFFFFFFFC ; Not SS_RIGHT, not SS_CENTER.
    IntOp $9 $9 | 1 ; SS_CENTER
    System::Call "user32::SetWindowLong(p r0, i -16, i r9)"
  ${EndIf}
FunctionEnd

; In: $R1 top and $R3 height at 100 %, $R4 the text. Out: $0 a new label in the middle of $HarnessPage.
Function ${UN}HarnessLabel
  ; WS_CHILD | WS_VISIBLE | SS_CENTER | SS_ENDELLIPSIS
  System::Call 'user32::CreateWindowEx(i 0, t "STATIC", t R4, i 0x50004001, i 0, i 0, i 1, i 1, p $HarnessPage, p 0, p 0, p 0) p .r0'
  SendMessage $HarnessPage ${WM_GETFONT} 0 0 $9
  SendMessage $0 ${WM_SETFONT} $9 1
  StrCpy $R2 0
  Push $0
  Call ${UN}HarnessCenter
  Pop $0
FunctionEnd

Function ${UN}HarnessGuiInit
  InitPluginsDir
  !insertmacro HarnessBrandFile 100
  !insertmacro HarnessBrandFile 125
  !insertmacro HarnessBrandFile 150
  !insertmacro HarnessBrandFile 175
  !insertmacro HarnessBrandFile 200
  Call ${UN}HarnessScale
  HarnessUI::Colors ${HARNESS_BG} ${HARNESS_TEXT} ${HARNESS_MUTED} ${HARNESS_HOVER} ${HARNESS_PRESSED}

  ; The title bar: dark (DWMWA_USE_IMMERSIVE_DARK_MODE, Windows 10 2004 and later), with the color
  ; of the page (DWMWA_CAPTION_COLOR and DWMWA_TEXT_COLOR, Windows 11), and no title and no icon
  ; (WTNCA_NODRAWCAPTION | WTNCA_NODRAWICON). The window buttons stay: the window can close.
  System::Call "*(i 1) p .r9"
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, p r9, i 4)"
  System::Free $9
  System::Call "*(i ${HARNESS_BG_COLORREF}) p .r9"
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, p r9, i 4)"
  System::Call "dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 36, p r9, i 4)"
  System::Free $9
  System::Call "*(i 3, i 3) p .r9"
  System::Call "uxtheme::SetWindowThemeAttribute(p $HWNDPARENT, i 1, p r9, i 8)"
  System::Free $9

  StrCpy $R9 $HWNDPARENT
  Call ${UN}HarnessDark
  ; No text at the bottom left: the copyright and the license are in the app.
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1256
  ShowWindow $0 ${SW_HIDE}
  Call ${UN}HarnessHideLines

  ; The header: the logo and the name in the middle, in place of the title of the page.
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_HIDE}
  StrCpy $R9 $HWNDPARENT
  StrCpy $R5 "header"
  StrCpy $R6 150
  StrCpy $R7 40
  StrCpy $R8 9
  Call ${UN}HarnessPicture
  StrCpy $HarnessHeader $R4
FunctionEnd

; A page with the header (for example the choice of the folder): it is dark, and the header shows the logo.
Function ${UN}HarnessInnerShow
  FindWindow $HarnessPage "#32770" "" $HWNDPARENT
  StrCpy $R9 $HarnessPage
  Call ${UN}HarnessDark
  ShowWindow $HarnessHeader ${SW_SHOW}
  Call ${UN}HarnessHideLines
FunctionEnd

; The progress page: the logo in the middle, the loading bar under it, and the status in the middle.
; In: $R4 the large status text.
Function ${UN}HarnessProgressPage
  FindWindow $HarnessPage "#32770" "" $HWNDPARENT
  ShowWindow $HarnessHeader ${SW_HIDE} ; The page shows the logo itself.
  ; No buttons while the files install: Next, Cancel, and Back.
  Call ${UN}HarnessHideButtons
  Call ${UN}HarnessHideLines
  GetDlgItem $0 $HarnessPage 1016 ; The list of details, and its button: the page shows its own details.
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HarnessPage 1027
  ShowWindow $0 ${SW_HIDE}

  Push $R4
  StrCpy $R9 $HarnessPage
  StrCpy $R5 "logo"
  StrCpy $R6 80
  StrCpy $R7 80
  StrCpy $R8 12
  Call ${UN}HarnessPicture
  Pop $R4

  ; The loading bar, under the logo.
  GetDlgItem $0 $HarnessPage 1004
  StrCpy $R1 108
  StrCpy $R2 300
  StrCpy $R3 6
  Call ${UN}HarnessCenter

  ; The large status line. The install page shows the percentage between the bar and this line.
  StrCpy $R1 146
  StrCpy $R3 26
  Call ${UN}HarnessLabel
  StrCpy $HarnessStatus $0
  CreateFont $HarnessBigFont "Segoe UI" 13 400
  SendMessage $HarnessStatus ${WM_SETFONT} $HarnessBigFont 1

  ; "Name: harness-daemon.exe... 37%": the status line of NSIS.
  GetDlgItem $0 $HarnessPage 1006
  StrCpy $R1 176
  StrCpy $R2 0
  StrCpy $R3 18
  Call ${UN}HarnessCenter

  StrCpy $R9 $HarnessPage
  Call ${UN}HarnessDark
FunctionEnd
!macroend

!insertmacro HARNESS_FUNCTIONS ""
!insertmacro HARNESS_FUNCTIONS "un."

; The welcome page and the finish page: the logo in the middle, the text under it.
; In: $R9 the page, $R1 the title, $R2 the text.
Function HarnessBigPage
  StrCpy $HarnessPage $R9
  Call HarnessHideLines
  Push $R1
  Push $R2
  StrCpy $R5 "logo"
  StrCpy $R6 80
  StrCpy $R7 80
  StrCpy $R8 36
  Call HarnessPicture
  Pop $R2
  Pop $R1
  StrCpy $0 $R1
  Push $R2
  StrCpy $R1 132
  StrCpy $R2 0
  StrCpy $R3 30
  Call HarnessCenter
  Pop $0
  StrCpy $R1 166
  StrCpy $R2 0
  StrCpy $R3 46
  Call HarnessCenter
FunctionEnd

Function HarnessInstFilesShow
  StrCpy $R4 "Installing ${PRODUCTNAME} ${VERSION}"
  Call HarnessProgressPage
  ; The percentage, directly under the loading bar: from 0% to 100%.
  StrCpy $R1 120
  StrCpy $R3 18
  StrCpy $R4 "0%"
  Call HarnessLabel
  StrCpy $HarnessPercent $0
  SetCtlColors $HarnessPercent ${HARNESS_MUTED} ${HARNESS_BG}
  StrCpy $R1 204
  StrCpy $R3 18
  StrCpy $R4 "$INSTDIR"
  Call HarnessLabel
  SetCtlColors $0 ${HARNESS_MUTED} ${HARNESS_BG}
FunctionEnd

Function un.HarnessInstFilesShow
  StrCpy $R4 "Uninstalling ${PRODUCTNAME}"
  Call un.HarnessProgressPage
FunctionEnd

; The percentage of the loading bar: its position in its range (NSIS sets both). The install
; section calls this between its commands, so it keeps the registers.
Function HarnessShowPercent
  ${If} $HarnessPercent == ""
    Return
  ${EndIf}
  Push $R0
  Push $R1
  Push $R2
  GetDlgItem $R0 $HarnessPage 1004
  SendMessage $R0 0x407 0 0 $R1 ; PBM_GETRANGE: the high limit.
  SendMessage $R0 0x408 0 0 $R2 ; PBM_GETPOS
  ${If} $R1 > 0
    IntOp $R2 $R2 * 100
    IntOp $R2 $R2 / $R1
  ${Else}
    StrCpy $R2 0
  ${EndIf}
  ${If} $R2 > 100
    StrCpy $R2 100
  ${EndIf}
  SendMessage $HarnessPercent ${WM_SETTEXT} 0 "STR:$R2%"
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

Function HarnessInstallDone
  ${If} $HarnessStatus != ""
    SendMessage $HarnessStatus ${WM_SETTEXT} 0 "STR:${PRODUCTNAME} is installed"
  ${EndIf}
  ${If} $HarnessPercent != ""
    SendMessage $HarnessPercent ${WM_SETTEXT} 0 "STR:100%"
  ${EndIf}
FunctionEnd

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW HarnessWelcomeShow
!define MUI_WELCOMEPAGE_TITLE "${PRODUCTNAME}"
!define MUI_WELCOMEPAGE_TEXT "Version ${VERSION}" ; Harness: the name under the logo, and the version under the name.
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. Custom page to ask user if he wants to reinstall/uninstall
;    only if a previous installation was detected
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the beginning
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ; Harness: one click. The page does not show: the install goes over the installed version.
  ${If} $PassiveMode <> 1
    StrCpy $HarnessOneClick 1
  ${EndIf}
  ${If} $PassiveMode = 1
  ${OrIf} $HarnessOneClick = 1
    Call PageLeaveReinstall
  ${Else}
    nsDialogs::Create 1018
    Pop $R4
    ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

    ${NSD_CreateLabel} 0 0 100% 24u $R1
    Pop $R1

    ${NSD_CreateRadioButton} 30u 50u -30u 8u $R2
    Pop $R2
    ${NSD_OnClick} $R2 PageReinstallUpdateSelection

    ${NSD_CreateRadioButton} 30u 70u -30u 8u $R3
    Pop $R3
    ; Disable this radio button if downgrading and downgrades are disabled
    !if "${ALLOWDOWNGRADES}" == "false"
      ${IfThen} $R0 = -1 ${|} EnableWindow $R3 0 ${|}
    !endif
    ${NSD_OnClick} $R3 PageReinstallUpdateSelection

    ; Check the first radio button if this the first time
    ; we enter this page or if the second button wasn't
    ; selected the last time we were on this page
    ${If} $ReinstallPageCheck <> 2
      SendMessage $R2 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${Else}
      SendMessage $R3 ${BM_SETCHECK} ${BST_CHECKED} 0
    ${EndIf}

    ${NSD_SetFocus} $R2
    Call HarnessInnerShow
    nsDialogs::Show
  ${EndIf}
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; Harness: one click, with no page. Install over the installed version: do not uninstall it first.
  ${If} $HarnessOneClick = 1
    ${If} $R0 = 0
      StrCpy $R1 1 ; The same version: "add or reinstall".
    ${Else}
      StrCpy $R1 0 ; A newer or an older version: "do not uninstall".
    ${EndIf}
  ${EndIf}

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other errors? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

; 5. Choose install directory page
; Harness: one click. The folder is the folder of the installed version, or the default folder.
!define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!define MUI_PAGE_CUSTOMFUNCTION_SHOW HarnessInnerShow
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!define MUI_PAGE_CUSTOMFUNCTION_SHOW HarnessInstFilesShow
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Harness: one click. The finish page shows when the install ends.
!define MUI_FINISHPAGE_TITLE "${PRODUCTNAME} is installed"
!define MUI_FINISHPAGE_TEXT "Choose what to do now, and click Finish."
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${PRODUCTNAME} now"
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!define MUI_PAGE_CUSTOMFUNCTION_SHOW HarnessFinishShow
!insertmacro MUI_PAGE_FINISH

; Harness: the welcome page and the finish page. These functions come after the pages: MUI makes
; the variables of a page ($mui.WelcomePage, $mui.FinishPage) when the script adds the page.
Function HarnessWelcomeShow
  ShowWindow $mui.WelcomePage.Image ${SW_HIDE}
  StrCpy $R9 $mui.WelcomePage
  StrCpy $R1 $mui.WelcomePage.Title
  StrCpy $R2 $mui.WelcomePage.Text
  Call HarnessBigPage
  ; The version: one muted line under the name.
  StrCpy $0 $mui.WelcomePage.Text
  StrCpy $R1 162
  StrCpy $R2 0
  StrCpy $R3 18
  Call HarnessCenter

  ; The install location, and the button to change it: a row in the middle, under the title.
  ${NSD_CreateLabel} 0 0 1 1 "Install location"
  Pop $HarnessDirLabel
  StrCpy $0 $HarnessDirLabel
  StrCpy $R1 200
  StrCpy $R2 380
  StrCpy $R3 16
  Call HarnessCenter
  ${NSD_CreateText} 0 0 1 1 "$INSTDIR"
  Pop $HarnessDirText
  SendMessage $HarnessDirText ${EM_SETREADONLY} 1 0
  ${NSD_CreateButton} 0 0 1 1 "Change…"
  Pop $R4
  ${NSD_OnClick} $R4 HarnessChangeDir
  ; The row is 380 px wide at 100 %: the folder (300 px), a gap, and the button (72 px).
  StrCpy $R9 $mui.WelcomePage
  Call HarnessWidth
  StrCpy $0 380
  Call HarnessPx
  IntOp $R0 $8 - $0
  IntOp $R0 $R0 / 2
  StrCpy $0 218
  Call HarnessPx
  StrCpy $R1 $0
  StrCpy $0 300
  Call HarnessPx
  StrCpy $R2 $0
  StrCpy $0 24
  Call HarnessPx
  StrCpy $R3 $0
  System::Call "user32::SetWindowPos(p $HarnessDirText, p 0, i R0, i R1, i R2, i R3, i 0x14)"
  StrCpy $0 308
  Call HarnessPx
  IntOp $R0 $R0 + $0
  StrCpy $0 72
  Call HarnessPx
  StrCpy $R2 $0
  System::Call "user32::SetWindowPos(p R4, p 0, i R0, i R1, i R2, i R3, i 0x14)"

  StrCpy $R9 $mui.WelcomePage
  Call HarnessDark
  SetCtlColors $HarnessDirText ${HARNESS_TEXT} ${HARNESS_FIELD} ; A read-only field gets the color of a label.
  SetCtlColors $HarnessDirLabel ${HARNESS_MUTED} ${HARNESS_BG}
  SetCtlColors $mui.WelcomePage.Text ${HARNESS_MUTED} ${HARNESS_BG}
  ; One click: the button of this page starts the install.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Install"
FunctionEnd

Function HarnessFinishShow
  ShowWindow $mui.FinishPage.Image ${SW_HIDE}
  StrCpy $R9 $mui.FinishPage
  StrCpy $R1 $mui.FinishPage.Title
  StrCpy $R2 $mui.FinishPage.Text
  Call HarnessBigPage
  ; The check boxes in the middle, under the text: the desktop shortcut, then the launch.
  StrCpy $0 $mui.FinishPage.ShowReadme
  StrCpy $R1 216
  StrCpy $R2 220
  StrCpy $R3 20
  Call HarnessCenter
  StrCpy $0 $mui.FinishPage.Run
  StrCpy $R1 240
  StrCpy $R2 220
  StrCpy $R3 20
  Call HarnessCenter
  StrCpy $R9 $mui.FinishPage
  Call HarnessDark
  ; The app is installed: there is nothing to go back to or to cancel. The install page hid
  ; Finish (button 1): show it again, at the far right.
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  Call HarnessNextFarRight
FunctionEnd

; The "Change" button of the first page: choose another install folder.
Function HarnessChangeDir
  Pop $0 ; The button.
  nsDialogs::SelectFolderDialog "Choose the folder for ${PRODUCTNAME}" "$INSTDIR"
  Pop $0
  StrCmp $0 "error" done ; The user cancelled.
  StrCpy $1 $0 1 -1
  StrCmp $1 "\" 0 +2
    StrCpy $0 $0 -1 ; A drive, for example "D:\".
  ; The app gets its own folder in the chosen folder, as on the folder page of NSIS.
  ${GetFileName} $0 $1
  StrCmp $1 "${PRODUCTNAME}" 0 +3
    StrCpy $2 $0
    Goto check
  StrCpy $2 $0
  StrCpy $0 "$0\${PRODUCTNAME}"
  check:
  ; The installer runs for one user, with no administrator rights: the folder must be writable.
  ClearErrors
  FileOpen $3 "$2\.harness-write-test" w
  IfErrors 0 writable
    MessageBox MB_OK|MB_ICONEXCLAMATION "${PRODUCTNAME} cannot install in $2, because it needs administrator rights there. Choose a folder in your user folder, for example $LOCALAPPDATA."
    Goto done
  writable:
  FileClose $3
  Delete "$2\.harness-write-test"
  StrCpy $INSTDIR $0
  ${NSD_SetText} $HarnessDirText $INSTDIR
  done:
FunctionEnd



Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
  Call un.HarnessInnerShow
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.HarnessInstFilesShow
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

; Harness: the status line of the install page says "Name: harness.exe... 37%".
LangString ^Extract ${LANG_ENGLISH} "Name: "

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR
  Call HarnessShowPercent

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"
  !insertmacro HarnessItemDone

  ; Harness: the daemon is the folder $INSTDIR\harness-daemon (a PyInstaller "onedir" folder, in the
  ; resources). Remove the folder of the previous version, so that no old file stays in it, and the
  ; onefile daemon of 0.1.26 and before (77 MB).
  RMDir /r "$INSTDIR\harness-daemon"
  Delete "$INSTDIR\harness-daemon.exe"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
    !insertmacro HarnessItemDone
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
    !insertmacro HarnessItemDone
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  Call HarnessInstallDone

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

; Harness: the install page has no buttons. After an error, show the buttons that close the window.
Function .onInstFailed
  Call HarnessShowCloseButtons
FunctionEnd

Function un.onUninstFailed
  Call un.HarnessShowCloseButtons
FunctionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${Else}
    ; Harness: the uninstaller has no finish page. Show "Close" (button 1) at the far right: the
    ; progress page hid it.
    Call un.HarnessNextFarRight
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
