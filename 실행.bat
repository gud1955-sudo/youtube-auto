@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo Flask 서버 시작 중...
echo 브라우저에서 http://localhost:5000 으로 접속하세요
echo.
python flask_app.py
pause
