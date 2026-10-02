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

## Versions and the archive

Each version that is installed or shared gets a git tag and a stored copy of its installer.

1. Commit the version change. Then tag the commit: `git tag -a v0.1.25 -m "Harness 0.1.25"`.
2. Copy the installer and its `.sig` file to `%USERPROFILE%\Harness releases\<version>\`.
3. Keep the last 3 versions in the archive. Delete the older version folders.
4. Delete the older installers in `client/src-tauri/target/release/bundle/nsis/`. That folder is
   build output: `cargo clean` deletes it.

Why: a git commit cannot rebuild an exact copy of an old installer, because the sidecar build uses
the Python and Node versions of the build computer. The stored copy lets you install an older
version again, for example to go back from a version with a problem. Do not commit installers to
git: they are about 90 MB each. When the public repository exists, the GitHub releases are the
archive (see below).

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

## Releases on GitHub and the updates

The repository is https://github.com/Wildm-an/Harness. The installed apps read
`https://github.com/Wildm-an/Harness/releases/latest/download/latest.json`
(`plugins.updater.endpoints` in `client/src-tauri/tauri.conf.json`).

The setup (done one time):

- The repository secret `TAURI_SIGNING_PRIVATE_KEY` (Settings > Secrets and variables > Actions) is
  the text of `~/.tauri/harness-updater.key`. The key has no password: the workflow sets an empty
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (GitHub accepts no empty secret).

For each release:

1. Raise the version (see the update steps of the project), and commit.
2. Tag the commit (`git tag -a v0.2.0 -m "Harness 0.2.0"`), and push the commit and the tag:
   `git push origin master v0.2.0`. Push one tag at a time: each tag starts a build of all platforms.
3. The workflow `.github/workflows/release.yml` builds and signs the installers, makes `latest.json`
   (`.github/scripts/latest_json.py`), and makes a draft release with all the files.
4. Check the draft release, and click "Publish release". `releases/latest` does not show drafts, so
   the installed apps find the new version only after this step.
5. The installed apps find the new version at launch, and with "Check for updates".

`latest.json` has the version, the date, and the URL and the signature of each platform:

```json
{
  "version": "0.2.0",
  "notes": "See https://github.com/Wildm-an/Harness/releases/tag/v0.2.0",
  "pub_date": "2026-10-01T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<the text of Harness_0.2.0_x64-setup.exe.sig>",
      "url": "https://github.com/Wildm-an/Harness/releases/download/v0.2.0/Harness_0.2.0_x64-setup.exe"
    }
  }
}
```

A version that was installed before the update address existed (0.1.30 and before) cannot find
updates: install the first release with the address by hand. Until the first release is published,
"Check for updates" tells the user that no published release was found.
