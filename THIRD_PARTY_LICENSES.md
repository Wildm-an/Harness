# Third-Party Licenses

This file lists the third-party components in the Harness installers and their licenses.
The audit date is 2026-10-02. The audit applies to version 0.1.31.
Version 0.1.32 removed the DeepSeek plugin host and its npm packages. This file does not list them.

The purpose of the audit is the application to SignPath Foundation for free code signing.
SignPath Foundation requires an OSI-approved license for all components.
SignPath Foundation does not accept a commercial dual license or a proprietary component, but it accepts system libraries.

## How the audit was made

The audit used only local data and package metadata:

- Rust: `cargo tree -e normal --target <triple> --format "{p}|{l}"` for six targets (Windows, macOS, and Linux, each on x86_64 and aarch64). The command reads the `license` field of each crate. It does not include dev-dependencies or build-dependencies. It includes proc-macro crates, which run at compile time only.
- Frontend: the `client/package-lock.json` entries without `"dev": true`, and the `license` field in `client/node_modules/**/package.json`.
- Python sidecar: the closure of the `dependencies` in `daemon/pyproject.toml`, with `importlib.metadata` in `daemon/.venv` (Python 3.11.9, Windows). The audit used the `License-Expression`, `License`, and classifier fields. It also read the CycloneDX SBOM files in the wheels that contain compiled Rust code.
- Bundled binaries: the built sidecar folder `client/src-tauri/binaries/harness-daemon/`, `daemon/packaging/harness-daemon.spec`, `daemon/scripts/build_sidecar.py`, `client/src-tauri/tauri.conf.json`, `client/src-tauri/tauri.bundle.json`, and `client/src-tauri/nsis/installer.nsi`.

The audit read the LICENSE file of a package when the metadata was not clear.
This file is not legal advice.

## Summary

| Ecosystem | Components | Result |
|---|---|---|
| Rust crates (all six targets) | 423 (283 on Windows x86_64) | All OSI-approved. 5 crates are MPL-2.0 (weak copyleft). |
| Frontend npm packages | 123 | All OSI-approved. 2 fonts are OFL-1.1. |
| Python packages in the sidecar | 50 | All OSI-approved. 2 packages are MPL-2.0. |
| Runtimes and other binaries | See sections 3, 4, and 5 | Two Microsoft runtime DLLs are proprietary system libraries. Some items use public domain or bzip2 terms. |

No component has a missing license, "UNLICENSED", "SEE LICENSE IN", BSL, SSPL, Elastic, or Commons Clause terms.
No component has a commercial dual license.

## 1. Rust crates (`client/src-tauri`)

The union of the six targets has 423 crates. The project crate `harness` (MIT) is not in the count.
Windows x86_64 uses 283 crates, macOS uses 283 crates, and Linux uses 363 crates.
The table normalizes the license expressions. For example, `MIT/Apache-2.0` and `Apache-2.0 OR MIT` become `MIT OR Apache-2.0`.

| License | Count | Packages |
|---|---|---|
| MIT OR Apache-2.0 | 261 | aes 0.8.4, anyhow 1.0.104, async-broadcast 0.7.2, async-channel 2.5.0, async-executor 1.14.0, async-io 2.6.0, async-lock 3.4.2, async-process 2.5.0, async-recursion 1.1.1, async-signal 0.2.14, async-task 4.7.1, async-trait 0.1.92, atomic-waker 1.1.2, base64 0.22.1, base64 0.23.1, bit-set 0.8.0, bit-vec 0.8.0, bitflags 1.3.2, bitflags 2.13.2, block-buffer 0.10.4, block-buffer 0.12.1, block-padding 0.3.3, blocking 1.7.0, camino 1.2.6, cargo-platform 0.1.9, cbc 0.1.2, cfg-if 1.0.5, chacha20 0.10.2, cipher 0.4.4, concurrent-queue 2.5.0, const-oid 0.10.2, cookie 0.18.2, core-foundation 0.10.1, core-foundation 0.9.4, core-foundation-sys 0.8.7, core-graphics 0.25.0, core-graphics-types 0.2.0, cpufeatures 0.2.17, cpufeatures 0.3.1, crc32fast 1.5.2, crossbeam-channel 0.5.17, crossbeam-utils 0.8.23, crypto-common 0.1.7, crypto-common 0.2.2, ctor 1.0.13, dbus 0.9.12, dbus-secret-service 4.1.0, deranged 0.5.8, digest 0.10.7, digest 0.11.3, dirs 7.0.0, dirs-sys 0.5.0, displaydoc 0.2.7, dtoa 1.0.11, dyn-clone 1.0.20, embed_plist 1.2.2, enumflags2 0.7.12, enumflags2_derive 0.7.12, equivalent 1.0.2, erased-serde 0.4.10, errno 0.3.14, event-listener 5.4.2, event-listener-strategy 0.5.4, fastrand 2.5.0, fdeflate 0.3.7, field-offset 0.3.6, filetime 0.2.29, flate2 1.1.10, fnv 1.0.7, foreign-types 0.5.0, foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, form_urlencoded 1.2.2, futures-channel 0.3.34, futures-core 0.3.34, futures-executor 0.3.34, futures-io 0.3.34, futures-lite 2.6.1, futures-macro 0.3.34, futures-sink 0.3.34, futures-task 0.3.34, futures-util 0.3.34, getrandom 0.2.17, getrandom 0.3.4, getrandom 0.4.3, glob 0.3.4, hashbrown 0.12.3, hashbrown 0.17.1, heck 0.4.1, heck 0.5.0, hex 0.4.3, hkdf 0.12.4, hmac 0.12.1, html5ever 0.39.0, http 1.5.0, httparse 1.10.1, hybrid-array 0.4.15, ident_case 1.0.1, idna 1.1.0, idna_adapter 1.2.2, indexmap 1.9.3, indexmap 2.14.2, inout 0.1.4, ipnet 2.12.2, itoa 1.0.18, json-patch 4.2.0, jsonptr 0.7.1, keyboard-types 0.8.3, keyring 3.6.3, libc 0.2.189, libdbus-sys 0.2.7, lock_api 0.4.14, log 0.4.34, markup5ever 0.39.0, mime 0.3.17, muda 0.20.0, num 0.4.3, num-bigint 0.4.8, num-complex 0.4.6, num-conv 0.2.2, num-integer 0.1.47, num-iter 0.1.46, num-rational 0.4.2, num-traits 0.2.19, once_cell 1.21.4, openssl-probe 0.2.1, ordered-stream 0.2.0, osakit 0.3.1, parking 2.2.1, parking_lot 0.12.5, parking_lot_core 0.9.12, percent-encoding 2.3.2, pin-project-lite 0.2.17, piper 0.2.5, png 0.17.16, png 0.18.1, polling 3.11.0, powerfmt 0.2.0, proc-macro-crate 1.3.1, proc-macro-crate 2.0.2, proc-macro-crate 3.5.0, proc-macro-error 1.0.4, proc-macro-error-attr 1.0.4, proc-macro2 1.0.107, quote 1.0.47, rand 0.10.3, rand_core 0.10.1, regex 1.13.1, regex-automata 0.4.18, regex-syntax 0.8.11, reqwest 0.13.5, rustc-hash 2.1.3, rustls-pki-types 1.15.1, rustls-platform-verifier 0.7.1, scopeguard 1.2.0, security-framework 3.7.0, security-framework-sys 2.17.0, semver 1.0.28, serde 1.0.229, serde-untagged 0.1.9, serde_core 1.0.229, serde_derive 1.0.229, serde_derive_internals 0.29.1, serde_json 1.0.151, serde_repr 0.1.21, serde_spanned 0.6.9, serde_spanned 1.1.1, serde_with 3.23.0, serde_with_macros 3.23.0, serialize-to-javascript 0.1.2, serialize-to-javascript-impl 0.1.2, servo_arc 0.4.3, sha1 0.11.0, sha2 0.10.9, signal-hook-registry 1.4.8, siphasher 1.0.4, smallvec 1.16.2, socket2 0.6.5, softbuffer 0.4.8, stable_deref_trait 1.2.1, string_cache 0.9.0, syn 1.0.109, syn 2.0.119, syn 3.0.6, system-configuration 0.7.0, system-configuration-sys 0.6.0, tar 0.4.46, tauri 2.12.0, tauri-codegen 2.7.0, tauri-macros 2.7.0, tauri-plugin-dialog 2.7.3, tauri-plugin-fs 2.5.2, tauri-plugin-opener 2.5.5, tauri-plugin-process 2.4.0, tauri-plugin-updater 2.13.1, tauri-plugin-window-state 2.5.0, tauri-runtime 2.12.0, tauri-runtime-wry 2.12.0, tauri-utils 2.10.0, tempfile 3.27.0, tendril 0.5.1, thiserror 1.0.69, thiserror 2.0.21, thiserror-impl 1.0.69, thiserror-impl 2.0.21, time 0.3.55, time-core 0.1.9, time-macros 0.2.32, tokio-rustls 0.26.6, toml 1.1.6+spec-1.1.0, toml_datetime 0.6.3, toml_datetime 1.1.1+spec-1.1.0, toml_edit 0.19.15, toml_edit 0.20.2, toml_edit 0.25.15+spec-1.1.0, toml_parser 1.1.3+spec-1.1.0, toml_writer 1.1.2+spec-1.1.0, tungstenite 0.30.0, typeid 1.0.3, typenum 1.20.1, unicode-segmentation 1.13.3, url 2.5.8, utf8_iter 1.0.4, uuid 1.26.1, web-time 1.1.0, web_atoms 0.2.6, window-vibrancy 0.8.1, windows 0.61.3, windows 0.62.2, windows-collections 0.2.0, windows-collections 0.3.2, windows-core 0.61.2, windows-core 0.62.2, windows-future 0.2.1, windows-future 0.3.2, windows-implement 0.60.2, windows-interface 0.59.3, windows-link 0.1.3, windows-link 0.2.1, windows-numerics 0.2.0, windows-numerics 0.3.1, windows-registry 0.6.1, windows-result 0.3.4, windows-result 0.4.1, windows-strings 0.4.2, windows-strings 0.5.1, windows-sys 0.52.0, windows-sys 0.60.2, windows-sys 0.61.2, windows-targets 0.52.6, windows-targets 0.53.5, windows-threading 0.1.0, windows-threading 0.2.1, windows-version 0.1.7, windows_aarch64_msvc 0.52.6, windows_aarch64_msvc 0.53.1, windows_x86_64_msvc 0.53.1, wry 0.57.0, xattr 1.6.1, zeroize 1.9.0, zeroize_derive 1.5.0 |
| MIT | 103 | atk 0.18.2, atk-sys 0.18.2, block2 0.6.2, bytes 1.12.1, cairo-rs 0.18.5, cairo-sys-rs 0.18.2, cargo_metadata 0.19.2, cfb 0.14.0, darling 0.24.1, darling_core 0.24.1, darling_macro 0.24.1, data-encoding 2.11.1, derive_more 2.1.1, derive_more-impl 2.1.1, dlopen2 0.8.2, dlopen2_derive 0.4.3, dom_query 0.28.0, endi 1.1.1, gdk 0.18.2, gdk-pixbuf 0.18.5, gdk-pixbuf-sys 0.18.0, gdk-sys 0.18.2, gdkwayland-sys 0.18.2, gdkx11 0.18.2, gdkx11-sys 0.18.2, generic-array 0.14.7, gio 0.18.4, gio-sys 0.18.1, glib 0.18.5, glib-macros 0.18.5, glib-sys 0.18.1, gobject-sys 0.18.0, gtk 0.18.2, gtk-sys 0.18.2, gtk3-macros 0.18.2, http-body 1.1.0, http-body-util 0.1.5, hyper 1.11.1, hyper-util 0.1.21, ico 0.5.0, infer 0.22.0, is-docker 0.2.0, is-wsl 0.4.0, javascriptcore-rs 1.1.2, javascriptcore-rs-sys 1.1.1, memoffset 0.9.1, minisign-verify 0.2.5, mio 1.2.3, new_debug_unreachable 1.0.6, objc2 0.6.4, objc2-encode 4.1.0, objc2-foundation 0.3.2, open 5.4.4, pango 0.18.3, pango-sys 0.18.0, phf 0.13.1, phf_generator 0.13.1, phf_macros 0.13.1, phf_shared 0.13.1, plist 1.10.1, precomputed-hash 0.1.1, quick-xml 0.42.0, rfd 0.16.0, schemars 0.8.22, schemars_derive 0.8.22, simd-adler32 0.3.10, slab 0.4.12, soup3 0.5.0, soup3-sys 0.5.0, strsim 0.11.1, synstructure 0.14.0, tokio 1.53.1, tokio-macros 2.7.2, tokio-tungstenite 0.30.0, tokio-util 0.7.19, tower 0.5.3, tower-http 0.6.11, tower-layer 0.3.3, tower-service 0.3.3, tracing 0.1.44, tracing-attributes 0.1.31, tracing-core 0.1.36, try-lock 0.2.5, urlpattern 0.6.0, want 0.3.1, webkit2gtk 2.0.2, webkit2gtk-sys 2.0.2, webview2-com 0.39.1, webview2-com-macros 0.8.1, webview2-com-sys 0.39.1, winnow 0.5.40, winnow 1.0.4, x11 2.21.0, x11-dl 2.21.0, zbus 5.19.0, zbus_macros 5.19.0, zbus_names 4.3.4, zcheapstr 1.1.0, zip 4.6.1, zmij 1.0.23, zvariant 5.15.0, zvariant_derive 5.15.0, zvariant_utils 4.2.0 |
| Unicode-3.0 | 18 | icu_collections 2.3.0, icu_locale_core 2.3.0, icu_normalizer 2.3.0, icu_normalizer_data 2.3.0, icu_properties 2.3.0, icu_properties_data 2.3.0, icu_provider 2.3.1, litemap 0.8.3, potential_utf 0.1.6, tinystr 0.8.4, writeable 0.6.4, yoke 0.8.3, yoke-derive 0.8.3, zerofrom 0.1.8, zerofrom-derive 0.1.8, zerotrie 0.2.5, zerovec 0.11.8, zerovec-derive 0.11.6 |
| MIT OR Apache-2.0 OR Zlib | 10 | dispatch2 0.3.1, miniz_oxide 0.8.9, miniz_oxide 0.9.1, objc2-app-kit 0.3.2, objc2-core-foundation 0.3.2, objc2-exception-helper 0.1.1, objc2-osa-kit 0.3.2, objc2-quartz-core 0.3.2, objc2-web-kit 0.3.2, raw-window-handle 0.6.2 |
| MIT OR Unlicense | 6 | aho-corasick 1.1.5, byteorder 1.5.0, memchr 2.8.3, same-file 1.0.6, walkdir 2.5.0, winapi-util 0.1.11 |
| MPL-2.0 | 5 | cssparser 0.37.0, cssparser-macros 0.7.1, dtoa-short 0.3.5, option-ext 0.2.0, selectors 0.38.0 |
| BSD-3-Clause | 3 | alloc-no-stdlib 3.0.0, alloc-stdlib 0.3.0, subtle 2.6.1 |
| MIT OR Apache-2.0 OR ISC | 3 | hyper-rustls 0.27.10, rustls 0.23.45, rustls-native-certs 0.8.4 |
| Apache-2.0 | 2 | sync_wrapper 1.0.2, tao 0.37.1 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 2 | linux-raw-sys 0.12.1, rustix 1.1.5 |
| ISC | 2 | rustls-webpki 0.103.15, untrusted 0.9.0 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 | unicode-ident 1.0.26 |
| Apache-2.0 AND ISC | 1 | ring 0.17.14 |
| Apache-2.0 AND MIT | 1 | dpi 0.1.2 |
| Apache-2.0 OR CC0-1.0 OR MIT-0 | 1 | dunce 1.0.5 |
| BSD-3-Clause AND MIT | 1 | brotli 9.0.0 |
| MIT OR Apache-2.0 OR 0BSD | 1 | adler2 2.0.1 |
| MIT OR BSD-3-Clause | 1 | brotli-decompressor 6.0.1 |
| Zlib | 1 | foldhash 0.2.0 |

Notes:

- `ring 0.17.14` is `Apache-2.0 AND ISC`. The LICENSE file of this version does not contain the old OpenSSL or SSLeay license. `rustls`, `reqwest`, and `tauri-plugin-updater` use it.
- Unicode-3.0 is OSI-approved.
- For a crate with an "OR" expression, Harness uses the crate under the MIT or Apache-2.0 option.
- The MPL-2.0 crates are in "Licenses to review".

## 2. Frontend npm packages (`client`)

These are the production `dependencies` of `client/package.json` and their transitive dependencies. The audit found 123 packages.
Vite puts the code of these packages into `client/dist`, and the installer contains `client/dist`.
The dev dependencies (`vite`, `typescript`, `vitest`, `@tauri-apps/cli`, and others) do not go into the bundle. Vite adds only a small MIT preload helper.
The `@types/*` packages contain only type declarations. They are in the list because the lock file marks them as production packages.

| License | Count | Packages |
|---|---|---|
| MIT | 112 | @monaco-editor/loader 1.7.0, @monaco-editor/react 4.7.0, @types/debug 4.1.13, @types/estree 1.0.9, @types/estree-jsx 1.0.5, @types/hast 3.0.5, @types/mdast 4.0.4, @types/ms 2.1.0, @types/react 19.3.0, @types/trusted-types 2.0.7, @types/unist 2.0.11, @types/unist 3.0.3, @xterm/addon-fit 0.11.0, @xterm/xterm 6.0.0, bail 2.0.2, ccount 2.0.1, character-entities 2.0.2, character-entities-html4 2.1.0, character-entities-legacy 3.0.0, character-reference-invalid 2.0.1, comma-separated-tokens 2.0.3, csstype 3.2.3, debug 4.4.3, decode-named-character-reference 1.3.0, dequal 2.0.3, devlop 1.1.0, escape-string-regexp 5.0.0, estree-util-is-identifier-name 3.0.0, extend 3.0.2, hast-util-to-jsx-runtime 2.3.6, hast-util-whitespace 3.0.0, html-url-attributes 3.0.1, inline-style-parser 0.2.7, is-alphabetical 2.0.1, is-alphanumerical 2.0.1, is-decimal 2.0.1, is-hexadecimal 2.0.1, is-plain-obj 4.1.0, longest-streak 3.1.0, markdown-table 3.0.4, marked 14.0.0, mdast-util-find-and-replace 3.0.2, mdast-util-from-markdown 2.0.3, mdast-util-gfm 3.1.0, mdast-util-gfm-autolink-literal 2.0.1, mdast-util-gfm-footnote 2.1.0, mdast-util-gfm-strikethrough 2.0.0, mdast-util-gfm-table 2.0.0, mdast-util-gfm-task-list-item 2.0.0, mdast-util-mdx-expression 2.0.1, mdast-util-mdx-jsx 3.2.0, mdast-util-mdxjs-esm 2.0.1, mdast-util-phrasing 4.1.0, mdast-util-to-hast 13.2.1, mdast-util-to-markdown 2.1.2, mdast-util-to-string 4.0.0, micromark 4.0.2, micromark-core-commonmark 2.0.3, micromark-extension-gfm 3.0.0, micromark-extension-gfm-autolink-literal 2.1.0, micromark-extension-gfm-footnote 2.1.0, micromark-extension-gfm-strikethrough 2.1.0, micromark-extension-gfm-table 2.1.2, micromark-extension-gfm-tagfilter 2.0.0, micromark-extension-gfm-task-list-item 2.1.0, micromark-factory-destination 2.0.1, micromark-factory-label 2.0.1, micromark-factory-space 2.0.1, micromark-factory-title 2.0.1, micromark-factory-whitespace 2.0.1, micromark-util-character 2.1.1, micromark-util-chunked 2.0.1, micromark-util-classify-character 2.0.1, micromark-util-combine-extensions 2.0.1, micromark-util-decode-numeric-character-reference 2.0.2, micromark-util-decode-string 2.0.1, micromark-util-encode 2.0.1, micromark-util-html-tag-name 2.0.1, micromark-util-normalize-identifier 2.0.1, micromark-util-resolve-all 2.0.1, micromark-util-sanitize-uri 2.0.1, micromark-util-subtokenize 2.1.0, micromark-util-symbol 2.0.1, micromark-util-types 2.0.2, monaco-editor 0.57.0, ms 2.1.3, parse-entities 4.0.2, property-information 7.2.0, react 19.3.0, react-dom 19.3.0, react-markdown 10.1.0, remark-gfm 4.0.1, remark-parse 11.0.0, remark-rehype 11.1.2, remark-stringify 11.0.0, scheduler 0.28.0, space-separated-tokens 2.0.2, state-local 1.0.7, stringify-entities 4.0.4, style-to-js 1.1.21, style-to-object 1.0.14, trim-lines 3.0.1, trough 2.2.0, unified 11.0.5, unist-util-is 6.0.1, unist-util-position 5.0.0, unist-util-stringify-position 4.0.0, unist-util-visit 5.1.0, unist-util-visit-parents 6.0.2, vfile 6.0.3, vfile-message 4.0.3, zwitch 2.0.4 |
| MIT OR Apache-2.0 | 5 | @tauri-apps/api 2.12.0, @tauri-apps/plugin-dialog 2.7.3, @tauri-apps/plugin-opener 2.5.5, @tauri-apps/plugin-process 2.4.0, @tauri-apps/plugin-updater 2.13.1 |
| ISC | 2 | @ungap/structured-clone 1.4.0, lucide-react 1.48.0 |
| OFL-1.1 | 2 | @fontsource/ibm-plex-sans 5.3.0, @fontsource/jetbrains-mono 5.3.0 |
| Apache-2.0 OR MPL-2.0 | 1 | dompurify 3.4.15 |
| BSD-3-Clause | 1 | diff 9.0.0 |

Notes:

- `dompurify` has the choice `MPL-2.0 OR Apache-2.0`. Harness uses it under Apache-2.0.
- `monaco-editor 0.57.0` is MIT. Its `ThirdPartyNotices.txt` lists the Node.js path library (MIT), marked (MIT), TypeScript (Apache-2.0), JS Beautifier (MIT), Ionic documentation (Apache-2.0), and vscode-swift (MIT). It also lists W3C, WHATWG (CC-BY-4.0), and Unicode texts for the HTML and CSS language data.
- The bundle contains `codicon.ttf` from `monaco-editor`. See "Licenses to review".
- The bundle contains the IBM Plex Sans and JetBrains Mono web fonts from `@fontsource`. Both fonts use the SIL Open Font License 1.1. OFL-1.1 is OSI-approved.
- The icons come from `lucide-react` (ISC).

## 3. Python packages in the sidecar (`daemon`)

The closure of the runtime `dependencies` in `daemon/pyproject.toml` has 50 distributions on Windows. The `dev` and `package` extras are not in the closure.
On macOS and Linux, `pywin32`, `pywinpty`, and `colorama` are not in the closure.

| License | Count | Packages |
|---|---|---|
| MIT | 22 | annotated-doc 0.0.5, annotated-types 0.8.0, anyio 4.15.1, attrs 26.1.0, fastapi 0.141.1, filelock 4.0.4, h11 0.16.0, jiter 0.17.0, jsonschema 4.26.0, jsonschema-specifications 2025.9.1, mcp 2.2.0, mcp-types 2.2.0, pydantic 2.13.5, pydantic_core 2.46.5, pyee 13.0.1, PyJWT 2.15.0, pywinpty 3.0.5, PyYAML 6.0.3, referencing 0.37.0, rpds-py 2026.6.3, truststore 0.10.4, typing-inspection 0.4.4 |
| BSD-3-Clause | 14 | click 8.5.0, colorama 0.4.6, fsspec 2026.9.0, httpcore 1.0.9, httpcore2 2.13.1, httpx 0.28.1, httpx2 2.13.1, idna 3.20, pycparser 3.0, pywin32 312, sse-starlette 3.4.11, starlette 1.7.0, uvicorn 0.54.0, websockets 17.1 |
| Apache-2.0 | 6 | hf-xet 1.6.0, huggingface_hub 2.0.0, openai 3.19.2, opentelemetry-api 1.45.0, playwright 1.63.0, python-multipart 0.0.32 |
| Apache-2.0 OR BSD-2-Clause | 1 | packaging 26.3 |
| Apache-2.0 OR BSD-3-Clause | 1 | cryptography 50.0.1 |
| MIT AND PSF-2.0 | 1 | greenlet 3.5.6 |
| MIT OR Apache-2.0 | 1 | sniffio 1.3.1 |
| MIT-0 | 1 | cffi 2.1.1 |
| MPL-2.0 | 1 | certifi 2026.7.22 |
| MPL-2.0 AND MIT | 1 | tqdm 4.70.1 |
| PSF-2.0 | 1 | typing_extensions 4.16.0 |

Notes:

- `colorama` and `pywinpty` have no license field. The classifiers and the LICENSE files show BSD-3-Clause and MIT.
- `pywin32 312` shows `License: PSF` in its metadata. The file `win32/License.txt` contains a BSD-3-Clause style text (Mark Hammond). The sidecar contains only `pywintypes311.dll` and four `win32` modules.
- The SBOM files of `cryptography`, `hf-xet`, `jiter`, `pydantic_core`, `pywinpty`, and `rpds-py` list the Rust crates in their compiled modules. All of those crates have OSI-approved licenses. Some crates have choices such as `MIT OR Apache-2.0 OR LGPL-2.1-or-later` or `Apache-2.0 OR GPL-2.0-only`. The permissive option applies.
- `hf-xet 1.6.0` is Apache-2.0. Its LICENSE file contains the Apache License 2.0. Its SBOM lists 238 crates, which include two MPL-2.0 crates (`colored`, `option-ext`).
- `cryptography 50.0.1` contains OpenSSL 4.0.2 in its compiled module. OpenSSL 3.0 and later use Apache-2.0.

### Python runtime and PyInstaller

| Component | License | OSI-approved | Note |
|---|---|---|---|
| CPython 3.11.9 (`python311.dll`, `python3.dll`, `base_library.zip`, `*.pyd`) | PSF-2.0 | Yes | The Python interpreter and standard library. |
| OpenSSL 3 (`libssl-3.dll`, `libcrypto-3.dll`) | Apache-2.0 | Yes | Part of the CPython Windows build. |
| libffi (`libffi-8.dll`) | MIT | Yes | Part of the CPython Windows build. |
| SQLite (`sqlite3.dll`) | Public domain | No (not a license) | Part of the CPython Windows build. See "Licenses to review". |
| bzip2 (in `_bz2.pyd`) | bzip2-1.0.6 | No (not on the OSI list) | Part of the CPython Windows build. See "Licenses to review". |
| liblzma / xz (in `_lzma.pyd`) | 0BSD / public domain | Yes (0BSD) | Part of the CPython Windows build. |
| expat (in `pyexpat.pyd`) | MIT | Yes | Part of the CPython Windows build. |
| `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` | Microsoft Visual C++ Redistributable terms | No (proprietary) | The Microsoft C runtime. See "Licenses to review". |
| PyInstaller 6.22.3 bootloader (`harness-daemon.exe`) | GPL-2.0-or-later with the Bootloader Exception | Yes | The exception permits distribution of the bootloader in any program. |
| PyInstaller runtime hooks | Apache-2.0 | Yes | `COPYING.txt` of PyInstaller states this. |
| winpty (`winpty.dll`, `winpty-agent.exe`) | MIT | Yes | From `pywinpty`. |
| `OpenConsole.exe`, `conpty.dll` | MIT | Yes | From Microsoft Terminal, through `pywinpty`. |

## 4. Playwright driver in the sidecar

The PyInstaller spec calls `collect_data_files("playwright")`. This copies the Playwright driver into `_internal/playwright/driver`.

| Component | Version | License | OSI-approved | Note |
|---|---|---|---|---|
| Node.js (`node.exe`) | 24.21.0 | MIT | Yes | The `LICENSE` file lists the bundled parts: V8, libuv, OpenSSL (Apache-2.0), ICU (Unicode), zlib, brotli, nghttp2, undici, and others. All are permissive. |
| `playwright-core` | 1.63.0 | Apache-2.0 | Yes | Microsoft. |
| Packages inlined in `lib/utilsBundle.js` and `lib/serverRegistry.js` | 81 packages | MIT, ISC, BSD-3-Clause, BlueOak-1.0.0 | Yes | Each bundle has a `.js.LICENSE` file with the full texts. |
| WebP codec (`lib/webp_codec.wasm`) | | BSD-3-Clause (libwebp), MIT or NCSA (Emscripten) | Yes | `lib/webp_codec.LICENSE`. |
| `codicon.ttf` in `lib/vite/*` | | See "Licenses to review" | | The same icon font as in Monaco. |

Chromium is not in the installer.
The spec does not collect a browser, and `harness_daemon/frozen.py` sets `PLAYWRIGHT_BROWSERS_PATH` to the cache folder of the user.
The user starts the download with `harness-daemon --install-browser` (`frozen.install_browser()`).

The Python package `playwright 1.63.0` is Apache-2.0 (see section 3).

## 5. Installer and other bundled files

| Component | License | OSI-approved | Note |
|---|---|---|---|
| NSIS (installer stub, header files, Modern UI 2) | zlib/libpng | Yes | `%LOCALAPPDATA%/tauri/NSIS/COPYING`. |
| NSIS LZMA compression module | CPL-1.0 | Yes | Tauri uses LZMA compression by default. |
| NSIS plug-in `NSISdl` | zlib/libpng | Yes | The installer uses it to download the WebView2 bootstrapper. |
| `nsis_tauri_utils.dll` | MIT OR Apache-2.0 | Yes | The Tauri NSIS plug-in. |
| `HarnessUI.dll` (`client/src-tauri/nsis/plugin/harness_ui.c`) | MIT | Yes | The code of the project. |
| `header.bmp`, `sidebar.bmp`, `nsis/brand/*.bmp` | MIT | Yes | The project made them (`nsis/make_images.py`). |
| App icons (`client/src-tauri/icons`, `client/public`, `client/assets`) | MIT | Yes | The project made them (`client/assets/make_icon.py`). |
| Daemon wheel (`binaries/daemon-wheel/harness_daemon-*.whl`) | MIT | Yes | The code of the project. The app sends it to remote daemons. |
| Microsoft Edge WebView2 bootstrapper | Microsoft terms | Not applicable | Not in the installer. The installer downloads it from Microsoft only when WebView2 is missing (`downloadBootstrapper`, the default). |

The Linux AppImage contains copies of system libraries from the build machine, for example WebKitGTK, GTK, and GLib.
These libraries use LGPL-2.0 or LGPL-2.1. The `.deb`, `.rpm`, and macOS packages do not contain them.

## Licenses to review

These items are not OSI-approved, have no license file, or have copyleft terms.

| # | Package | Version | License found | Why it matters | Recommendation |
|---|---|---|---|---|---|
| 1 | `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` (sidecar `_internal`) | From the CPython 3.11.9 Windows build | Microsoft Visual C++ Redistributable terms (proprietary) | SignPath does not accept proprietary components. These DLLs are the Microsoft C runtime, which is a system library. | Ask SignPath. Tell them that the files are the MSVC runtime, which the system library exception covers. |
| 2 | `codicon.ttf` (frontend bundle, from `monaco-editor`; also in the Playwright driver) | `monaco-editor 0.57.0`, `playwright-core 1.63.0` | The packages are MIT and Apache-2.0. The upstream `microsoft/vscode-codicons` project uses CC-BY-4.0 for the icon font. | CC-BY-4.0 is not an OSI license for software. The file is an icon font, not code. | Accept. Name it in the notices. Ask SignPath only if they question it. |
| 3 | Monaco and TypeScript language data (`html.worker`, `css.worker`, `ts.worker`) | `monaco-editor 0.57.0` | WHATWG text under CC-BY-4.0, W3C text under the W3C license | The CC-BY-4.0 part is not an OSI license. It is documentation text inside the data, not code. | Accept. |
| 4 | SQLite (`sqlite3.dll`) | From the CPython 3.11.9 Windows build | Public domain dedication | Public domain is not an OSI license. SQLite is part of the standard Python distribution. | Accept. Ask SignPath only if they question it. |
| 5 | bzip2 (in `_bz2.pyd`) | From the CPython 3.11.9 Windows build | bzip2-1.0.6 (a BSD style license) | The license is permissive, but it is not on the OSI list. It is part of the standard Python distribution. | Accept. Ask SignPath only if they question it. |
| 6 | `cssparser`, `cssparser-macros`, `dtoa-short`, `selectors`, `option-ext` (Rust) | 0.37.0, 0.7.1, 0.3.5, 0.38.0, 0.2.0 | MPL-2.0 | OSI-approved, weak copyleft at the file level. A change to these files must be published under MPL-2.0. Harness does not change them. The first four come through `tauri-utils` (`dom_query`). | Accept. |
| 7 | `certifi` (Python) | 2026.7.22 | MPL-2.0 | OSI-approved, weak copyleft at the file level. The package is the CA certificate file. Harness does not change it. | Accept. |
| 8 | `tqdm` (Python) | 4.70.1 | MPL-2.0 AND MIT | OSI-approved, weak copyleft at the file level. Harness does not change it. | Accept. |
| 9 | `colored`, `option-ext` (Rust crates inside `hf_xet.pyd`) | 3.1.1, 0.2.0 | MPL-2.0 | OSI-approved, weak copyleft at the file level. | Accept. |
| 10 | `dompurify` (frontend) | 3.4.15 | MPL-2.0 OR Apache-2.0 | A choice with a copyleft option. | Accept under Apache-2.0. |
| 11 | PyInstaller bootloader (`harness-daemon.exe`) | 6.22.3 | GPL-2.0-or-later with the Bootloader Exception | OSI-approved copyleft. The exception removes the GPL conditions for the combined program. | Accept. |
| 12 | `pywin32` (Python) | 312 | Metadata says `PSF`. The license file is BSD-3-Clause style. | The metadata and the license file do not agree. Both are permissive. | Accept. Use BSD-3-Clause in the notices. |
| 13 | WebKitGTK, GTK, GLib and other system libraries (Linux AppImage only) | From the build machine | LGPL-2.0 or LGPL-2.1 | OSI-approved copyleft. They are system libraries. They are not in the Windows installer. | Accept. SignPath signs the Windows installer only. |
