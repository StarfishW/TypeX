; Custom steps for the Windows installer (included by electron-builder).
;
; The installer starts with a language selector. The language chosen there is
; written next to the application, and TypeX uses it as its interface language
; when it next starts (see applyInstallerLanguage in src/main/index.ts).

!include LogicLib.nsh

!macro customInstall
  ; $LANGUAGE holds the Windows language ID of the installer's language.
  ${If} $LANGUAGE == 2052
    StrCpy $0 "zh-CN"
  ${ElseIf} $LANGUAGE == 1028
    StrCpy $0 "zh-TW"
  ${ElseIf} $LANGUAGE == 1041
    StrCpy $0 "ja"
  ${ElseIf} $LANGUAGE == 1042
    StrCpy $0 "ko"
  ${ElseIf} $LANGUAGE == 1031
    StrCpy $0 "de"
  ${ElseIf} $LANGUAGE == 1036
    StrCpy $0 "fr"
  ${ElseIf} $LANGUAGE == 3082
    StrCpy $0 "es"
  ${ElseIf} $LANGUAGE == 1034
    StrCpy $0 "es"
  ${ElseIf} $LANGUAGE == 1046
    StrCpy $0 "pt-BR"
  ${ElseIf} $LANGUAGE == 1049
    StrCpy $0 "ru"
  ${Else}
    StrCpy $0 "en"
  ${EndIf}
  ClearErrors
  FileOpen $1 "$INSTDIR\resources\installer-language.txt" w
  ${IfNot} ${Errors}
    FileWrite $1 "$0"
    FileClose $1
  ${EndIf}
!macroend
