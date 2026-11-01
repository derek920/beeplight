#!/bin/sh
# Prints the Homebrew cask for the DMG that `npm run app:dist` built, for the tap repository
# (<owner>/homebrew-tap, file Casks/beeplight.rb). Upload that same DMG to the GitHub release
# v<version>: the cask pins its sha256.
#   sh scripts/homebrew-cask.sh <owner>/<repo> > ../homebrew-tap/Casks/beeplight.rb
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO=${1:?usage: sh scripts/homebrew-cask.sh <owner>/<repo>}
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json")
DMG="$ROOT/desktop/build/Beeplight-$VERSION.dmg"
[ -f "$DMG" ] || { echo "✗ 没有 ${DMG}，先运行 npm run app:dist" >&2; exit 1; }
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw "$ROOT/desktop/Info.plist")

cat <<EOF
cask "beeplight" do
  version "$VERSION"
  sha256 "$SHA"

  url "https://github.com/$REPO/releases/download/v#{version}/Beeplight-#{version}.dmg"
  name "Beeplight"
  desc "Menu bar status light for Claude Code sessions"
  homepage "https://beeplight.dev"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :sonoma

  app "Beeplight.app"

  uninstall quit: "$BUNDLE_ID"

  zap trash: [
    "~/Library/Application Support/Beeplight",
    "~/Library/Caches/$BUNDLE_ID",
    "~/Library/HTTPStorages/$BUNDLE_ID",
    "~/Library/Preferences/$BUNDLE_ID.plist",
  ]
end
EOF
