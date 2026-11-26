; Hearth for Windows: the setup program (Hearth-Setup.exe). windows/package.sh builds it on a Mac or Linux when
; NSIS is installed (brew install makensis), from the same files as the zip.
;  - Installs for the current user, without administrator rights, into %LOCALAPPDATA%\Programs\Hearth.
;  - Adds Hearth to the Start menu (and, if wanted, to the desktop) and to Settings > Apps, where it can be removed.
;  - Never touches the user's data in %LOCALAPPDATA%\Hearth (models, chats, settings, extensions): installing a newer
;    version replaces only the program, and removing Hearth asks before deleting the data (the answer is No by default).
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef SRC
  !error "Pass /DSRC=<the folder with the Windows files>"
!endif
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "Hearth-Setup.exe"
!endif
!define UNINST "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hearth"

Name "Hearth"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Hearth"
InstallDirRegKey HKCU "Software\Hearth" "InstallDir"
BrandingText "Hearth ${VERSION}"

!define MUI_ICON "${SRC}/hearth.ico"
!define MUI_UNICON "${SRC}/hearth.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(RunHearth)"
!define MUI_FINISHPAGE_RUN_FUNCTION StartHearth

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; The setup speaks the language of Windows when it is Russian, and English otherwise.
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Russian"

LangString RunHearth ${LANG_ENGLISH} "Start Hearth"
LangString RunHearth ${LANG_RUSSIAN} "Запустить Hearth"
LangString SecApp ${LANG_ENGLISH} "Hearth"
LangString SecApp ${LANG_RUSSIAN} "Hearth"
LangString SecDesktop ${LANG_ENGLISH} "Desktop shortcut"
LangString SecDesktop ${LANG_RUSSIAN} "Ярлык на рабочем столе"
LangString Tagline ${LANG_ENGLISH} "Hearth - AI on this computer"
LangString Tagline ${LANG_RUSSIAN} "Hearth — ИИ на этом компьютере"
LangString AskData ${LANG_ENGLISH} "Also delete Hearth's data: downloaded models, chats, settings and extensions?$\r$\n$\r$\nThey are in $LOCALAPPDATA\Hearth. Choose No to keep them, for example to install Hearth again."
LangString AskData ${LANG_RUSSIAN} "Удалить и данные Hearth: скачанные модели, чаты, настройки и расширения?$\r$\n$\r$\nОни лежат в $LOCALAPPDATA\Hearth. Нажмите «Нет», чтобы оставить их, например для повторной установки."

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "Hearth"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "Hearth setup"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "Hearth"

; A running Hearth is asked to stop (as Settings > Quit does) so its files can be replaced. The script finds the port
; Hearth really uses, waits until it has closed (up to a minute: it unloads the model first), then ends whatever of
; Hearth is still running from this folder or its data folder; the pause lets Windows release the files.
!macro StopHearth SCRIPT
  IfFileExists "${SCRIPT}" 0 +3
    ExecWait '"$SYSDIR\wscript.exe" //B "${SCRIPT}" /quiet "$INSTDIR"'
    Sleep 1500
!macroend

Section "!$(SecApp)" SecApp
  SectionIn RO
  ; The stop script from this setup, so a Hearth started from anywhere (the zip, an older copy) stops first.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop.vbs" "${SRC}/Stop-Hearth.vbs"
  !insertmacro StopHearth "$PLUGINSDIR\stop.vbs"

  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\app" ; the old program; the user's data lives elsewhere and stays
  File /r /x "Make-Desktop-Shortcut.vbs" "${SRC}/*.*"
  WriteUninstaller "$INSTDIR\Uninstall Hearth.exe"

  ; Explorer is 64-bit, so the shortcuts name the real System32, whatever this setup program sees.
  CreateShortcut "$SMPROGRAMS\Hearth.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\Hearth.vbs"' "$INSTDIR\hearth.ico" 0 SW_SHOWNORMAL "" "$(Tagline)"

  WriteRegStr HKCU "Software\Hearth" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "DisplayName" "Hearth"
  WriteRegStr HKCU "${UNINST}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST}" "DisplayIcon" "$INSTDIR\hearth.ico"
  WriteRegStr HKCU "${UNINST}" "Publisher" "Hearth"
  WriteRegStr HKCU "${UNINST}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST}" "UninstallString" '"$INSTDIR\Uninstall Hearth.exe"'
  WriteRegStr HKCU "${UNINST}" "QuietUninstallString" '"$INSTDIR\Uninstall Hearth.exe" /S'
  WriteRegDWORD HKCU "${UNINST}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNINST}" "EstimatedSize" $0
SectionEnd

Section "$(SecDesktop)" SecDesktop
  CreateShortcut "$DESKTOP\Hearth.lnk" "$WINDIR\System32\wscript.exe" '"$INSTDIR\Hearth.vbs"' "$INSTDIR\hearth.ico" 0 SW_SHOWNORMAL "" "$(Tagline)"
SectionEnd

Function StartHearth
  Exec '"$WINDIR\System32\wscript.exe" "$INSTDIR\Hearth.vbs"'
FunctionEnd

Section "Uninstall"
  !insertmacro StopHearth "$INSTDIR\Stop-Hearth.vbs"
  Delete "$DESKTOP\Hearth.lnk"
  Delete "$SMPROGRAMS\Hearth.lnk"
  ; Only what this setup put there, in case the folder was shared with other files.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  Delete "$INSTDIR\Hearth.vbs"
  Delete "$INSTDIR\Stop-Hearth.vbs"
  Delete "$INSTDIR\Hearth (with console).bat"
  Delete "$INSTDIR\README.txt"
  Delete "$INSTDIR\hearth.ico"
  Delete "$INSTDIR\Uninstall Hearth.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST}"
  DeleteRegKey HKCU "Software\Hearth"
  ; Starting with Windows (Settings > This computer) is this user's Run entry.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Hearth"
  ; The data stays unless the user says otherwise (and always when uninstalling silently).
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(AskData)" /SD IDNO IDNO keep
    RMDir /r "$LOCALAPPDATA\Hearth"
  keep:
SectionEnd
