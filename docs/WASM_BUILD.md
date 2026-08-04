# Building Rclone for WebAssembly

This document explains how the `rclone.wasm` file is built for this ChromeOS Extension.

## Background
The official `rclone` WebAssembly target (`fs/rc/js/main.go`) expects a browser UI environment with access to the DOM object (`document`). This makes it incompatible with modern Chrome Extension Service Workers, which run headless.

To resolve this, we provide a custom `main.go` bridge (`src/wasm-bridge/main.go`) that exposes the `rclone` API globally on `self` without relying on DOM elements.

## Prerequisites
- A Linux environment with `curl`, `tar`, and `git`. (You do not strictly need Go pre-installed; our build script will download it).

## How to Build

We have provided a dedicated build script: `build-wasm.sh`.

You can simply run it from the root of this project:
```bash
./build-wasm.sh
```

### What does the script do?
1.  **Downloads Go**: Downloads the specific Go toolchain version natively (to avoid system-wide installations and dependency hell). Currently targets Go 1.22.x.
2.  **Clones Rclone**: Clones the official `rclone` repository into a temporary build directory.
3.  **Injects Custom Bridge**: Copies our `src/wasm-bridge/main.go` into the `rclone` source tree, replacing the official `fs/rc/js/main.go`.
4.  **Compiles**: Uses `GOOS=js GOARCH=wasm` to compile the `fs/rc/js` module.
5.  **Copies Artifacts**: Moves the compiled `rclone.wasm` and the matching `wasm_exec.js` from the Go runtime into the extension's `src/` directory.

## Updating Rclone Version
If you wish to build a newer or older version of rclone, simply edit `build-wasm.sh` and modify the `RCLONE_REPO` or `RCLONE_BRANCH` variables.
