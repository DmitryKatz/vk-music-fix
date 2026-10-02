@echo off
setlocal
title VK Music Fix - установка

set "SRC=%~dp0extension"
set "DEST=%LOCALAPPDATA%\VKMusicFix"

if not exist "%SRC%\manifest.json" goto :notunpacked

echo.
echo   VK Music Fix - установка
echo   ========================
echo.
echo   Копирую расширение в %DEST%
robocopy "%SRC%" "%DEST%" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :copyfail

<nul set /p "=%DEST%" | clip

echo.
echo   Готово. Путь к папке расширения уже лежит в буфере обмена.
echo.
echo   Сейчас откроется Chrome на странице расширений. Там:
echo.
echo     1. Справа вверху включи "Режим разработчика".
echo     2. Нажми "Загрузить распакованное расширение".
echo     3. В окне выбора папки щёлкни в адресную строку сверху,
echo        нажми Ctrl+V, Enter, потом кнопку "Выбор папки".
echo     4. Обнови вкладку с ВК (F5). Внизу слева появится кнопка "Fix".
echo.
echo   Если расширение уже стояло: на его карточке нажми круглую стрелку
echo   (обновить), потом обнови вкладку с ВК.
echo.
echo   Если страница расширений не открылась - вставь в адресную строку
echo   Chrome: chrome://extensions
echo.

set "HASCHROME="
reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1 && set "HASCHROME=1"
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1 && set "HASCHROME=1"
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe" >nul 2>&1 && set "HASCHROME=1"
if defined HASCHROME start "" chrome "chrome://extensions/"

pause
exit /b 0

:notunpacked
echo.
echo   Не вижу папку "extension" рядом с этим файлом.
echo   Сначала распакуй архив: ПКМ по архиву - "Извлечь все...",
echo   потом запусти INSTALL.bat уже из распакованной папки.
echo.
pause
exit /b 1

:copyfail
echo.
echo   Не получилось скопировать файлы в %DEST%
echo.
pause
exit /b 1
