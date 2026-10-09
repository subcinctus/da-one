# First-time setup: the checklist for the user

Give the user one step at a time, with the exact menu names below, and ask with AskUserQuestion ("Done,
continue" / "I can't do this now") whenever they must act. Menu names can differ slightly between iOS and Xcode
versions; follow what the screen shows.

## What the user needs

- A Mac whose macOS can run the Xcode that supports the iPhone's iOS version. For an iPhone on iOS 26 that is
  Xcode 26, which needs macOS 15.6 or newer; the Mac App Store shows which Xcode the Mac can install.
- The full Xcode app from the Mac App Store (the "Command Line Tools" alone are not enough).
- An Apple account. A free account works; a paid Apple Developer Program membership avoids the weekly re-signing.
- The iPhone and a USB cable that carries data (not a charge-only cable).
- No jailbreak and no other software are needed.

## The steps

1. **Install Xcode** from the Mac App Store (a large download). Open it once, click **Agree** on the license, and
   let it install its components. If it offers platforms, include **iOS**.
   - If Xcode is missing its iOS component later (a build says "iOS ... is not installed"), open Xcode >
     Settings > **Components**, click **Get** next to iOS, and wait until it finishes.
   - If only the Command Line Tools are selected, the user runs
     `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` in Terminal (it asks for their Mac
     password; they type it themselves).
2. **Sign in to Xcode:** Xcode > Settings... > **Accounts** > **+** > Apple Account, then sign in. A free account
   appears as "<Name> (Personal Team)". The user types the password and any code themselves; never ask for them.
3. **Connect the iPhone** with the cable, unlock it, tap **Trust** when it asks "Trust This Computer?", and enter
   the iPhone passcode on the iPhone. Then open Xcode > Window > **Devices and Simulators** and wait until
   "Preparing iPhone" finishes (it can take several minutes the first time). Seeing the iPhone in Finder is not
   enough.
4. **Developer Mode:** on the iPhone, Settings > **Privacy & Security** > **Developer Mode** > On, let it
   restart, then unlock it and tap **Turn On**.
   - If Developer Mode is not listed, open Xcode > Window > Devices and Simulators with the iPhone connected and
     unlocked, wait until "Preparing iPhone" finishes, then look again. A missing entry does not mean the iPhone
     is unsupported.
5. **UI Automation:** on the iPhone, Settings > **Developer** > **Enable UI Automation** > On.
6. **Claude prepares the helper:** discover, configure, fetch and build (the user just watches).
   - **During the first build** the Mac may ask "codesign wants to access key ... in your keychain". The user
     enters their Mac login password and clicks **Always Allow**. The build waits until they do.
7. **Trust the developer app** if the iPhone asks: Settings > **General** > **VPN & Device Management** > under
   "Developer App" tap "Apple Development: <their Apple Account>" > **Trust**.
8. **Keep the iPhone unlocked** and connected while Claude uses it. For long sessions the user may set
   Settings > Display & Brightness > **Auto-Lock** > Never (and set it back later). Quit the **iPhone
   Mirroring** app on the Mac if it is open.
9. **Free Apple account:** about every 7 days, ask Claude to "rebuild the iPhone helper" (Claude runs build, then
   start).

## Good to know (tell the user once)

- **Personal Team limits:** a free account can have about 3 development apps on the iPhone at once, and their
  signature lasts about 7 days. The helper counts as one app. Claude never removes other apps; the user decides.
- **Keyboard settings:** while the helper runs it turns off the keyboard's Auto-Correction and Predictive text so
  that typed text arrives exactly. They can be turned back on in Settings > General > Keyboard.
- **USB only by default:** the helper accepts connections only over the USB cable. It is not reachable from the
  Wi-Fi unless the user agrees to change that later.
- **Stopping:** when the user is done for the day, Claude can stop the helper. Nothing is uninstalled.
- **Where things are kept:** settings, logs and screenshots stay in a private folder on this Mac
  (`~/.local/share/iphone-use`); the newest 40 screenshots are kept.

## Signing problems during the build

- "Signing requires a development team" or "No signing identity": the Apple account is not signed in to Xcode,
  or the wrong team was chosen. Step 2, then configure and build again.
- "Bundle identifier cannot be registered" or "is not available": the generated ID is taken. Configure a new
  unique `bundle_id`, then build. (The installed helper's ID ends in `.xctrunner`.)
- "Maximum number of apps": the free-account limit of about 3 apps. The user decides what to remove; never delete
  apps yourself.
- More: [troubleshooting](troubleshooting.md).
