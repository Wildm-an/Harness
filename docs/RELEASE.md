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

To build a release again with the same version (for example after a fix that has no new version):

1. Push the fix to `master`, and move the tag to the new commit:
   `git tag -f -a v0.1.34 <commit> -m "Harness 0.1.34"`, then `git push --force origin refs/tags/v0.1.34`.
   The moved tag starts the workflow.
2. Or keep the tag, and start the workflow by hand with the tag:
   `gh workflow run release.yml --ref master -f tag=v0.1.34`. It builds the code of the tag.
   If the build of the tag failed and the fix is in a later commit, add the commit:
   `gh workflow run release.yml --ref master -f tag=v0.1.34 -f ref=<commit>`, with the full
   40-character hash of the commit (`git rev-parse <commit>`): the checkout step does not accept a
   short hash. The workflow builds
   that commit and puts the files on the release of the tag. The tag does not move, so the
   "Source code" downloads of the release still show the code of the tag.
3. The workflow sees that the release exists. It replaces the files with the same names and the
   release keeps its state (draft or published). It does not make a second release.

An installed app that has the same version does not see an update. To get the new build, run the
setup file of the release again.

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
    },
    "windows-aarch64": {
      "signature": "<the text of Harness_0.2.0_arm64-setup.exe.sig>",
      "url": "https://github.com/Wildm-an/Harness/releases/download/v0.2.0/Harness_0.2.0_arm64-setup.exe"
    }
  }
}
```

The other platforms are `darwin-aarch64`, `darwin-x86_64`, and `linux-x86_64`.

## Windows on ARM

The job `windows-arm64` builds a native ARM64 installer, `Harness_<version>_arm64-setup.exe`, on
the GitHub runner `windows-11-arm`.

- PyInstaller cannot cross-compile, so the job builds the sidecar on the ARM64 runner.
- The job uses Python 3.12 (ARM64). Python 3.11 has no ARM64 wheel of PyYAML.
- Tauri builds for `aarch64-pc-windows-msvc`. The files are in
  `client/src-tauri/target/aarch64-pc-windows-msvc/release/bundle/nsis/`.
- The installer itself is an x86 NSIS program (the same as the x64 installer), with the
  HarnessUI plugin. Windows on ARM runs it under emulation. It installs the ARM64 app.
- The ARM64 wheel of pywinpty has no `winpty-agent.exe`. The terminal uses ConPTY, so the
  sidecar does not need it.
- The ARM64 app gets the `windows-aarch64` entry of `latest.json`. An x64 app that runs under
  emulation on an ARM64 computer keeps the `windows-x86_64` entry.
- The job is optional (`continue-on-error`): if it fails, the release still has the other
  platforms, with no `windows-aarch64` entry. Check the job result of each release.

To test the job with no release: `gh workflow run release.yml --ref <branch>`. Download the
artifact `harness-windows-arm64`, and run `latest_json.py` on its folder to see the entry.

A release before the ARM64 job has no ARM64 installer, and it does not need one: the apps read
`latest.json` of the newest release only. The ARM64 job needs the changes of the same commit in
`daemon/packaging/harness-daemon.spec` and `client/scripts/package.mjs`, so it cannot build the
code of an earlier tag. To add ARM64 to a release of an earlier tag, use a `ref` that has the
version of the tag and these changes. That run builds all platforms again and replaces the files of
that release only.

A version that was installed before the update address existed (0.1.30 and before) cannot find
updates: install the first release with the address by hand. Until the first release is published,
"Check for updates" tells the user that no published release was found.
