#!/usr/bin/env bash
# Build Factory.app (menu bar app for the tpm software factory).
#   ./build.sh            -> apps/menubar/build/Factory.app
#   ./build.sh --install  -> also copies it to ~/Applications
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release --product FactoryMenu
BIN="$(swift build -c release --show-bin-path)/FactoryMenu"
APP=build/Factory.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/FactoryMenu"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.htalat.tpm.factory</string>
  <key>CFBundleName</key><string>Factory</string>
  <key>CFBundleDisplayName</key><string>Factory</string>
  <key>CFBundleExecutable</key><string>FactoryMenu</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>tpm software factory</string>
</dict>
</plist>
PLIST
# Ad-hoc signature (local use; notifications need a signed bundle).
codesign --force --sign - "$APP"
echo "built $(pwd)/$APP"
if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/Factory.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "installed ~/Applications/Factory.app"
fi
