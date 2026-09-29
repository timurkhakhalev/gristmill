# OpenHercules → Gristmill: one-time local migration

The rename changes the app name, bundle id, keychain service names and profile
paths. There are no compatibility shims: run these steps once per machine,
**with the old OpenHercules app quit**, before the first Gristmill launch.
Everything is a copy or move; nothing is deleted until you remove the old app.

| | Old | New |
|---|---|---|
| Bundle id | `com.openhercules.desktop` | `com.khakhalev.gristmill` |
| Dev bundle id | `com.openhercules.desktop.dev` | `com.khakhalev.gristmill.dev` |
| URL scheme | `openhercules://`, `openhercules-dev://` | `gristmill://`, `gristmill-dev://` |
| Profile | `~/Library/Application Support/OpenHercules` | `…/Gristmill` |
| Dev profile | `…/OpenHercules-development` | `…/Gristmill-development` |
| Env vars | `OPENHERCULES_*`, `VITE_OPENHERCULES_*` | `GRISTMILL_*`, `VITE_GRISTMILL_*` |
| CLI bridge dir | `~/.openhercules/` | `~/.gristmill/` |
| Model cache | `~/.cache/openhercules` | `~/.cache/gristmill` |

## 1. Quit the old app and back up

```sh
osascript -e 'quit app "OpenHercules"'
cp -R ~/Library/Application\ Support/OpenHercules ~/OpenHercules-profile-backup   # optional, ~2.5 GB
```

## 2. Profile directory

```sh
cd ~/Library/Application\ Support
mv OpenHercules Gristmill
[ -d OpenHercules-development ] && mv OpenHercules-development Gristmill-development
# Renderer session partition (localStorage/settings) was renamed persist:openhercules → persist:gristmill
mv Gristmill/Partitions/openhercules Gristmill/Partitions/gristmill
[ -d Gristmill-development/Partitions/openhercules ] && \
  mv Gristmill-development/Partitions/openhercules Gristmill-development/Partitions/gristmill
```

## 3. Keychain (API keys become undecryptable without this)

Two items: the secrets master key (`src/helpers/secretCrypto.ts`) and Electron's
safeStorage key (`<app name> Safe Storage`, used for encrypted blobs and cookies).
macOS may ask for your login password.

```sh
KEY=$(security find-generic-password -s OpenHercules -a secrets-master-key -w)
security add-generic-password -s Gristmill -a secrets-master-key -w "$KEY" -U
unset KEY

SS=$(security find-generic-password -s "OpenHercules Safe Storage" -a "OpenHercules Key" -w)
security add-generic-password -s "Gristmill Safe Storage" -a "Gristmill Key" -w "$SS" -U
unset SS
```

The first launch of the new app will ask for keychain access once; choose
"Always Allow". `secure-keys/master-key-backup.enc` lives in the profile and moved
with it in step 2.

## 4. Other paths and shell config

```sh
[ -d ~/.openhercules ] && mv ~/.openhercules ~/.gristmill
[ -d ~/.cache/openhercules ] && mv ~/.cache/openhercules ~/.cache/gristmill
grep -rn OPENHERCULES ~/.zshrc ~/.zprofile ~/.zshenv ~/dev/**/.env 2>/dev/null   # rename to GRISTMILL_*
```

## 5. Permissions and old app

The new bundle id is a different app for macOS: Microphone, System Audio,
Calendar and Accessibility prompts appear again. This is expected.

After Gristmill starts and your notes, keys and settings are confirmed, remove
`/Applications/OpenHercules.app` and the old `openhercules://` handler goes with it.
The old TCC entries can be cleared with
`tccutil reset All com.openhercules.desktop`.
