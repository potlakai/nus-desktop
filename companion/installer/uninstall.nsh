; Nus Companion 0.1.38: what happens when a person uninstalls (not on an update).
; electron-builder inserts this macro into its uninstaller before the files go
; (nsis.include in electron-builder.companion.config.js).
;
; 1. Starts Nus once with --uninstalled. That run sends one anonymous stats row,
;    app_exit {reason: uninstall}, only if stats are on, and ends by itself
;    within 4 s (src/main-companion.js). It is stopped after 8 s whatever happens.
; 2. Opens the site's one question, "What made you uninstall?"
;    (feedback.html?why=uninstall). Nothing from this computer goes with it.
;
; Neither runs on an update (the old uninstaller is started with --updated) or
; on a silent uninstall someone scripted with /S.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${GetParameters} $R8
    ClearErrors
    ${GetOptions} $R8 "/S" $R9
    ${if} ${Errors}
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$p = Start-Process -FilePath '$INSTDIR\${APP_EXECUTABLE_FILENAME}' -ArgumentList '--uninstalled' -PassThru; if (-not $$p.WaitForExit(8000)) { Stop-Process -Id $$p.Id -Force }"`
      Pop $R9
      ExecShell "open" "https://potlakai.github.io/nus/feedback.html?why=uninstall"
    ${endIf}
  ${endIf}
!macroend
