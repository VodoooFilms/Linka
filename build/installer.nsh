!macro customInstall
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Linka" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --hidden'
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Linka"
!macroend
