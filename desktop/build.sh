#!/bin/sh
# Builds "Beeplight.app": compiles the SwiftUI shell and bundles the Node service, and the node
# binary that runs it, into it.
#   sh desktop/build.sh            → desktop/build/Beeplight.app, for this Mac's chip
#   sh desktop/build.sh --install  → also copies it to ~/Applications
#   sh desktop/build.sh --dist     → a universal app (Apple silicon + Intel), packed as
#                                     desktop/build/Beeplight-<version>.dmg to share
# The bundled node is the official Node.js NODE_DIST release, downloaded once from nodejs.org,
# checked against its SHASUMS256.txt and cached in desktop/build/node.
# BEEPLIGHT_NODE=/path/to/node bundles that binary instead (not with --dist). It isn't NODE,
# because `npm run` sets NODE to the node running npm, which may need dylibs the app doesn't carry.
# Signing is ad-hoc unless SIGN_IDENTITY is set:
#   SIGN_IDENTITY="Developer ID Application: …"  signs with the hardened runtime, as notarization
#                                                 requires (SIGN_IDENTITY=- tries it ad-hoc)
#   NOTARY_PROFILE=<name>  with --dist, also notarizes and staples the DMG; the name is a keychain
#                          profile saved with `xcrun notarytool store-credentials`
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DESK="$ROOT/desktop"
BUILD="$DESK/build"
APP="$BUILD/Beeplight.app"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")
NODE_DIST=24.22.2
MODE=${1:-}
if [ "$MODE" = "--dist" ]; then ARCHS="arm64 x86_64"; else ARCHS=$(uname -m); fi

# Prints the path of the official node binary for one architecture, downloading it if needed.
official_node() {
  [ "$1" = "x86_64" ] && pkg=x64 || pkg=arm64
  dir="$BUILD/node/v$NODE_DIST"
  name="node-v$NODE_DIST-darwin-$pkg"
  if [ ! -x "$dir/$name/bin/node" ]; then
    mkdir -p "$dir"
    url="https://nodejs.org/dist/v$NODE_DIST"
    [ -f "$dir/SHASUMS256.txt" ] || curl -fsSL "$url/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"
    echo "→ 下载 $name.tar.gz" >&2
    curl -fL --progress-bar "$url/$name.tar.gz" -o "$dir/$name.tar.gz"
    (cd "$dir" && grep " $name.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) \
      || { echo "✗ $name.tar.gz 校验失败" >&2; rm -f "$dir/$name.tar.gz"; exit 1; }
    tar -xzf "$dir/$name.tar.gz" -C "$dir" "$name/bin/node" "$name/LICENSE"
    rm -f "$dir/$name.tar.gz"
  fi
  echo "$dir/$name/bin/node"
}

# Assembled aside and moved into place once signed: a build that stops halfway leaves the previous
# app intact, instead of a bundle without Info.plist that crashes at launch.
OUT="$APP"
APP="$BUILD/partial/Beeplight.app"
rm -rf "$BUILD/partial"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/server"

echo "→ 编译 SwiftUI 应用（${ARCHS}）"
slices=""
for arch in $ARCHS; do
  swiftc -parse-as-library -O -target "$arch-apple-macos14" -o "$BUILD/Beeplight-$arch" "$DESK"/Sources/*.swift
  slices="$slices $BUILD/Beeplight-$arch"
done
# shellcheck disable=SC2086
lipo -create $slices -output "$APP/Contents/MacOS/Beeplight"
# shellcheck disable=SC2086
rm -f $slices

echo "→ 生成图标"
swiftc -O -o "$BUILD/make-icon" "$DESK/Icon.swift"
rm -rf "$BUILD/AppIcon.iconset"
"$BUILD/make-icon" "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

# Users don't need Node installed. Node.js is MIT-licensed; its license ships alongside.
if [ -n "${BEEPLIGHT_NODE:-}" ] && [ "$MODE" != "--dist" ]; then
  NODE_BIN=$(realpath "$BEEPLIGHT_NODE")
  "$NODE_BIN" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)' \
    || { echo "✗ 需要 Node ≥ 20.11：$BEEPLIGHT_NODE"; exit 1; }
  cp "$NODE_BIN" "$APP/Contents/MacOS/node"
  NODE_LICENSE="$(dirname "$NODE_BIN")/../LICENSE"
else
  nodes=""
  for arch in $ARCHS; do nodes="$nodes $(official_node "$arch")"; done
  # shellcheck disable=SC2086
  lipo -create $nodes -output "$APP/Contents/MacOS/node"
  NODE_LICENSE="$(dirname "$(official_node "$(uname -m)")")/../LICENSE"
fi
[ -f "$NODE_LICENSE" ] && cp "$NODE_LICENSE" "$APP/Contents/Resources/node-LICENSE"

# Run it from inside the bundle, so a node that needs dylibs left outside fails the build here.
NODE_VERSION=$("$APP/Contents/MacOS/node" --version) \
  || { echo "✗ 打包进 app 的 node 无法运行（Homebrew 的 node 依赖 libnode.dylib，不能单独复制）"; exit 1; }
echo "→ 打包监控服务（node ${NODE_VERSION}，$(lipo -archs "$APP/Contents/MacOS/node")）"
cp -R "$ROOT/src" "$ROOT/public" "$ROOT/package.json" "$APP/Contents/Resources/server/"
cp -R "$DESK"/Resources/*.lproj "$APP/Contents/Resources/"
sed -e "s|__VERSION__|$VERSION|g" "$DESK/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

if [ -n "${SIGN_IDENTITY:-}" ]; then
  [ "$SIGN_IDENTITY" = "-" ] && TIMESTAMP=--timestamp=none || TIMESTAMP=--timestamp
  echo "→ 签名（${SIGN_IDENTITY}，hardened runtime）"
  codesign --force --options runtime $TIMESTAMP --entitlements "$DESK/node.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP/Contents/MacOS/node"
  codesign --force --options runtime $TIMESTAMP --entitlements "$DESK/Beeplight.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --strict --deep "$APP"
else
  # Ad-hoc signature: enough for local use, notifications and Apple Events prompts.
  codesign --force --sign - "$APP/Contents/MacOS/node"
  codesign --force --sign - "$APP"
fi
rm -rf "$OUT"
mv "$APP" "$OUT"
rmdir "$BUILD/partial"
APP="$OUT"

case "$MODE" in
  --install)
    mkdir -p "$HOME/Applications"
    rm -rf "$HOME/Applications/Beeplight.app"
    cp -R "$APP" "$HOME/Applications/"
    echo "✓ 已安装到 ~/Applications/Beeplight.app"
    ;;
  --dist)
    DMG="$BUILD/Beeplight-$VERSION.dmg"
    STAGE="$BUILD/dmg"
    rm -rf "$STAGE" "$DMG"
    mkdir -p "$STAGE"
    ditto "$APP" "$STAGE/Beeplight.app"
    ln -s /Applications "$STAGE/Applications"
    hdiutil create -quiet -volname Beeplight -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG"
    rm -rf "$STAGE"
    if [ -n "${SIGN_IDENTITY:-}" ] && [ "$SIGN_IDENTITY" != "-" ]; then
      codesign --timestamp --sign "$SIGN_IDENTITY" "$DMG"
    fi
    if [ -n "${NOTARY_PROFILE:-}" ]; then
      [ -n "${SIGN_IDENTITY:-}" ] && [ "$SIGN_IDENTITY" != "-" ] \
        || { echo "✗ 公证需要 Developer ID 签名：设置 SIGN_IDENTITY"; exit 1; }
      echo "→ 公证（一般几分钟）"
      # Apple notarizes the app inside along with the DMG, so a copy installed from it passes too.
      out=$(xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait 2>&1) || true
      echo "$out"
      echo "$out" | grep -q 'status: Accepted' \
        || { echo "✗ 公证没通过，查原因：xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE"; exit 1; }
      xcrun stapler staple "$DMG"
      spctl --assess --type open --context context:primary-signature --verbose "$DMG"
    fi
    echo "✓ ${DMG}（$(du -h "$DMG" | cut -f1)，$(lipo -archs "$APP/Contents/MacOS/Beeplight")）"
    echo "  sha256 $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
    ;;
  *)
    echo "✓ $APP"
    ;;
esac
