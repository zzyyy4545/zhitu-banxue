@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   知途伴学 · 公网隧道（localhost.run 免费）
echo ============================================
echo.
echo 说明：
echo   未注册账号 = 随机临时地址（每次重启会变）
echo   已绑定 SSH 密钥的免费账号 = 固定子域名（推荐）
echo.
echo 启动后，公网地址会显示在弹出的黑色窗口里。
echo 关闭该窗口 = 断开公网访问。电脑睡眠/关机也会断开。
echo.
echo 按任意键启动隧道...
pause >nul
echo 正在拉起隧道...
ssh -i .ssh/id_lhr -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:3000 nokey@localhost.run
pause
