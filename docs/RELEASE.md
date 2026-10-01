# Releases and app updates

Harness uses the Tauri updater (`tauri-plugin-updater`). Settings > General > Updates checks for
a new version, installs it, and starts the app again.

## The installer

`npm run package` in `client/` builds the app (`client/scripts/package.mjs`).

- On Windows, it builds only the NSIS installer (`tauri.windows.conf.json`). The MSI is not used:
  it installs a second copy of the app for all users.
- The installer is in `client/src-tauri/target/release/bundle/nsis/`.
- With the release key, the build also signs the installer. The signature file is next to the
  installer, with the extension `.sig`.

## The release key

The updater accepts only an update with a correct signature.

- The private key is in `~/.tauri/harness-updater.key`. The public key is in
  `~/.tauri/harness-updater.key.pub`, and also in `plugins.updater.pubkey` of
  `client/src-tauri/tauri.conf.json`.
- Keep a backup copy of the private key in a safe place. Do not put it in the repository.
- If you lose the private key, the installed apps cannot get updates. The users must then install
  a new version by hand.
- The build reads the key from `TAURI_SIGNING_PRIVATE_KEY`, or from the file in
  `HARNESS_UPDATER_KEY`, or from `~/.tauri/harness-updater.key`. With no key, the build makes the
  installer with no signature.

## Start the updates (when the public repository exists)

1. Put the update address in `plugins.updater.endpoints` of `client/src-tauri/tauri.conf.json`,
   for example `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.
2. For each release, raise the version (see the update steps of the project), and build with
   `npm run package`.
3. Make a release in the repository. Attach the installer, and a `latest.json` file:

   ```json
   {
     "version": "0.2.0",
     "notes": "The changes of this version.",
     "pub_date": "2026-10-01T12:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<the text of Harness_0.2.0_x64-setup.exe.sig>",
         "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/Harness_0.2.0_x64-setup.exe"
       }
     }
   }
   ```

4. The installed apps find the new version with "Check for updates".

Until step 1, "Check for updates" tells the user that the build has no update address.
