# Finding an app's bundle ID

`iphone_launch_app` needs the app's exact bundle ID, for example `com.apple.mobilenotes` for Notes. Look it up
with `iphone_apps`; never guess one.

## When to look up

- A known, verified bundle ID (from an earlier lookup in this conversation, or a built-in app below) can be
  launched directly. You do not need to check the installed list before every launch.
- Common apps: `iphone_apps(query="Notes", source="catalog")` searches the bundled list offline.
- Unknown apps, or several apps with similar names: `iphone_apps(query=..., source="auto")` (the default).
- Never build a bundle ID from a brand name, and never try several guesses in a row.

Example: `iphone_apps` with `{"query": "Notes"}` returns a candidate `{"name": "Notes", "bundle_id":
"com.apple.mobilenotes", "origin": "installed", "installed_verified": true, ...}`. Then call
`iphone_launch_app(bundle_id="com.apple.mobilenotes")`.

## Sources

- **`auto`** (default): the chosen iPhone's installed apps (cached for 5 minutes) merged with the bundled list.
  Exact name or alias matches win: if any exact match exists, partial matches are dropped. Apple's App Store
  search runs only when nothing matched locally.
- **`installed`**: only the chosen iPhone's installed apps. If no iPhone is configured yet, or the list cannot be
  read, the result says how to fix it.
- **`catalog`**: the bundled list of Apple's built-in apps and well-known apps (WhatsApp, Gmail, Outlook, Teams,
  Slack, Zoom, LinkedIn and others). Offline; no phone or network access.
- **`apple`**: Apple's public App Store search for a storefront country, by default `in` (set another with
  `country`, for example `us` or `gb`, or change the default with `iphone_setup(action=configure,
  app_store_country=...)`). Store results **do not prove** the app is installed.

## Reading the candidates

Each candidate has `name`, `bundle_id`, `aliases`, `publisher` (when known), `origin` (installed, catalog or
apple), `installed_verified` and `installation_checked`, plus `store_url`, `track_id` and `country` for store
results.

- `installed_verified=true` means the chosen iPhone's installed list confirmed it. **Only this is proof that the
  app is installed.**
- `installation_checked` says whether this lookup actually read the installed list. `false` does not mean "not
  installed".
- Only matching apps are returned, never the iPhone's full app list. The installed list stays in the private
  iPhone Use folder; nothing about the iPhone is sent to Apple.
- `warnings` explains a source that could not be read; `app_lookup_unavailable` means no source worked.

## Before launching

- Check the name, the publisher and where the candidate came from, then pass `bundle_id` to
  `iphone_launch_app`. Launch optimistically; if the next page is unknown, set `observe=tree` on the launch.
- **Similar apps are different apps.** WhatsApp and WhatsApp Business, Outlook and Mail, a bank's main app and
  its separate card or investment app, or a "Lite" edition are checked separately. If the user's wording fits
  more than one installed app, ask which one.
- **No results?** Try `source="installed"`, or the user's actual App Store country. Not found in one country's
  store does not mean not installed. Enterprise, test or unlisted apps may not be in the store at all.
- If launching fails (`invalid_argument` or the app does not come to the front), look at the screen; never try
  other made-up IDs.

## Built-in apps (well-known bundle IDs)

| App | Bundle ID |
| --- | --- |
| Settings | `com.apple.Preferences` |
| Safari | `com.apple.mobilesafari` |
| Messages | `com.apple.MobileSMS` |
| Mail | `com.apple.mobilemail` |
| Phone | `com.apple.mobilephone` |
| Calendar | `com.apple.mobilecal` |
| Notes | `com.apple.mobilenotes` |
| Reminders | `com.apple.reminders` |
| Photos | `com.apple.mobileslideshow` |
| Camera | `com.apple.camera` |
| Contacts | `com.apple.MobileAddressBook` |
| Maps | `com.apple.Maps` |
| Wallet | `com.apple.Passbook` |
| Files | `com.apple.DocumentsApp` |
| App Store | `com.apple.AppStore` |

The Home Screen itself is `com.apple.springboard` (go there with `iphone_press_button(name=home)`, not by
launching it).
