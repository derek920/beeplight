#!/bin/sh
# Runs the monitor as a per-user LaunchAgent, so it keeps running independently of any
# terminal or Claude session: starts at login, restarts if it dies.
set -eu

LABEL=app.beeplight.service
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE=${NODE:-$(command -v node)}
PORT=${PORT:-7333}

case "${1:-}" in
  install)
    mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/data/server.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/server.log</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "已安装并启动：http://localhost:$PORT"
    echo "日志：$ROOT/data/server.log"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "已停止并卸载"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "已重启"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) =' || echo "未安装"
    ;;
  *)
    echo "用法: $0 install | uninstall | restart | status" >&2
    exit 1
    ;;
esac
