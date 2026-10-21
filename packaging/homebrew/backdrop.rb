# Homebrew cask for Backdrop. It goes in a tap repository (github.com/anthonyradke/homebrew-tap,
# as Casks/backdrop.rb) so that `brew install --cask anthonyradke/tap/backdrop` works.
# For each release: build the .dmg with scripts/build-mac.sh, attach it to a GitHub release
# tagged v<version>, then update `version` and `sha256` (`shasum -a 256 Backdrop_*.dmg`).
cask "backdrop" do
  version "0.1.0"
  sha256 :no_check

  url "https://github.com/anthonyradke/backdrop/releases/download/v#{version}/Backdrop_#{version}_aarch64.dmg"
  name "Backdrop"
  desc "Live wallpapers with an optional self-hosted library server"
  homepage "https://github.com/anthonyradke/backdrop"

  depends_on macos: ">= :monterey"
  depends_on arch: :arm64

  app "Backdrop.app"

  uninstall quit:       "com.anthonyradke.backdrop",
            launchctl:  "Backdrop"

  zap trash: [
    "~/Library/Application Support/com.anthonyradke.backdrop",
    "~/Library/Caches/com.anthonyradke.backdrop",
    "~/Library/LaunchAgents/Backdrop.plist",
    "~/Library/WebKit/com.anthonyradke.backdrop",
  ]

  caveats <<~EOS
    Backdrop isn't notarized yet. If macOS refuses to open it, run:
      xattr -dr com.apple.quarantine "#{appdir}/Backdrop.app"
  EOS
end
