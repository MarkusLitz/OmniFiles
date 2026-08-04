#!/bin/bash
set -e

# Configuration
GO_VERSION="1.25.0"
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then ARCH="amd64"; fi
if [ "$ARCH" = "aarch64" ]; then ARCH="arm64"; fi

GO_TARBALL="go${GO_VERSION}.${OS}-${ARCH}.tar.gz"
GO_URL="https://go.dev/dl/${GO_TARBALL}"
RCLONE_REPO="https://github.com/rclone/rclone.git"
# Pinned rclone revision. Builds MUST be reproducible: an unpinned branch would
# silently change the shipped binary (and could break the line-based transport
# patch in step 5) between builds. This commit is rclone master shortly after
# the v1.74.0 tag — it is the exact revision the currently shipped
# src/rclone.wasm was built from. Bump deliberately and re-test after bumping.
RCLONE_COMMIT="5f791079fc3325d156377c83abdde65cecf61721"
PROJECT_DIR="$(pwd)"
BUILD_DIR="$(pwd)/build_tmp"
SRC_DIR="$(pwd)/src"

echo "=== ChromeOS Rclone WASM Builder ==="

# 1. Setup Build Directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# 2. Download and Extract Go (if not exists or wrong version)
if ! [ -x "go/bin/go" ] || ! go/bin/go version | grep -q "go${GO_VERSION} "; then
    echo "[*] Downloading Go ${GO_VERSION}..."
    rm -rf go
    curl -sL "$GO_URL" | tar -xz
fi
export PATH="$(pwd)/go/bin:$PATH"

# Force the local toolchain. Bumping RCLONE_COMMIT may now require bumping
# GO_VERSION too if rclone's go.mod demands a newer version.
export GOTOOLCHAIN=local

# 3. Clone Rclone at the pinned commit (if not exists), or realign an existing
# checkout that sits on a different revision.
if [ ! -d "rclone" ]; then
    echo "[*] Fetching Rclone at pinned commit ${RCLONE_COMMIT}..."
    git init -q rclone
    git -C rclone remote add origin "$RCLONE_REPO"
    git -C rclone fetch -q --depth 1 origin "$RCLONE_COMMIT"
    git -C rclone checkout -q FETCH_HEAD
else
    CURRENT_COMMIT="$(git -C rclone rev-parse HEAD)"
    if [ "$CURRENT_COMMIT" != "$RCLONE_COMMIT" ]; then
        echo "[*] Existing checkout at ${CURRENT_COMMIT}; realigning to pinned ${RCLONE_COMMIT}..."
        git -C rclone fetch -q --depth 1 origin "$RCLONE_COMMIT"
        git -C rclone checkout -q -f FETCH_HEAD
    fi
fi
echo "[*] Rclone revision: $(git -C rclone rev-parse HEAD)"

# 4. Inject Custom Bridge
echo "[*] Injecting custom main.go bridge..."
cp "$SRC_DIR/wasm-bridge/main.go" "rclone/fs/rc/js/main.go"

# 5. Inject js/wasm HTTP Transport Override
# In Go's js/wasm, setting DialContext on http.Transport bypasses the
# fetch-based roundtripper and falls back to the fake TCP stack.
# The fake TCP stack cannot do DNS in Chrome Extension Service Workers.
# We split the transport functions into non-js (http_notjs.go) and js (transport_js.go).
echo "[*] Injecting js/wasm HTTP transport override..."

# Move NewTransportCustom and NewTransport out of http.go into a !js file
# Step 1: Get the line range of NewTransportCustom..NewTransport in http.go
FSHTTP="rclone/fs/fshttp"

# Make sure we're starting with a clean http.go before patching
git -C rclone restore fs/fshttp/http.go || true

# Extract NewTransportCustom and NewTransport from http.go into transport_notjs.go.
# These two functions use DialContext which breaks WASM. We replace them with
# a js/wasm version in transport_js.go.
TRANSPORT_START=$(grep -n "^// NewTransportCustom" "$FSHTTP/http.go" | head -1 | cut -d: -f1)
NEWCLIENT_LINE=$(grep -n "^// NewClient " "$FSHTTP/http.go" | head -1 | cut -d: -f1)

# Build transport_notjs.go with the original functions (imports included inline via build-tagged file)
cat > "$FSHTTP/transport_notjs.go" << EOF
//go:build !js

package fshttp

import (
	"context"
	"net"
	"net/http"
	"net/url"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/lib/structs"
)

EOF
sed -n "${TRANSPORT_START},$((NEWCLIENT_LINE - 1))p" "$FSHTTP/http.go" >> "$FSHTTP/transport_notjs.go"

# Remove those lines from http.go
sed -i "${TRANSPORT_START},$((NEWCLIENT_LINE - 1))d" "$FSHTTP/http.go"

# Remove the now-unused imports from http.go (net/url and structs; net stays for NewClientCustom)
sed -i '/"net\/url"/d' "$FSHTTP/http.go"
sed -i '/"github.com\/rclone\/rclone\/lib\/structs"/d' "$FSHTTP/http.go"

# Also net is still used in http.go (NewClientCustom unix socket), so leave it.
# Verify net is still referenced:
if ! grep -q '"net"' "$FSHTTP/http.go"; then
    # net was removed but shouldn't be - this is a safety check
    echo "WARNING: 'net' import may be missing from http.go"
fi

# Write the js/wasm specific override
cat > "$FSHTTP/transport_js.go" << 'GOEOF'
//go:build js && wasm

package fshttp

import (
	"context"
	"crypto/tls"
	"net/http"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/lib/structs"
)

// NewTransportCustom for js/wasm returns an http.RoundTripper backed by
// JavaScript's fetch() API. DialContext must NOT be set because doing so
// causes Go to use the fake TCP/DNS stack, which fails with
// "Connection reset by peer" in Chrome Extension Service Workers.
func NewTransportCustom(ctx context.Context, customize func(*http.Transport)) *Transport {
	ci := fs.GetConfig(ctx)

	t := new(http.Transport)
	structs.SetDefaults(t, http.DefaultTransport.(*http.Transport))

	// Explicitly clear dial functions so Go WASM uses fetch() for HTTP/HTTPS
	t.DialContext = nil
	t.DialTLSContext = nil

	// Initialize TLSClientConfig to prevent nil-pointer panic in RoundTrip
	t.TLSClientConfig = &tls.Config{
		InsecureSkipVerify: ci.InsecureSkipVerify,
	}

	t.DisableKeepAlives = ci.DisableHTTPKeepAlives
	t.DisableCompression = ci.NoGzip

	if customize != nil {
		customize(t)
	}

	return newTransport(ci, t)
}

// NewTransport returns an http.RoundTripper with fetch-based transport for js/wasm
func NewTransport(ctx context.Context) *Transport {
	(*noTransport).Do(func() {
		transport = NewTransportCustom(ctx, nil)
	})
	return transport
}
GOEOF

# 6. Compile WASM
# -trimpath is REQUIRED, not an optimization: without it Go bakes the absolute
# build directory into the binary for tracebacks, so every one of the ~2200
# embedded source paths leaks the builder's local filesystem layout (username
# and all) into a binary that ships to every end user. -trimpath rewrites them
# to module-relative paths, which also makes the output build-host independent.
echo "[*] Compiling rclone.wasm (-trimpath)..."
cd rclone/fs/rc/js
GOOS=js GOARCH=wasm go build -trimpath -v -o rclone.wasm .

echo "[*] Asserting embedded Go version..."
EMBEDDED_VERSION=$(strings -a rclone.wasm | grep -oE '^go1\.[0-9]+(\.[0-9]+)?$' | sort -u)
if [ "$EMBEDDED_VERSION" != "go${GO_VERSION}" ]; then
    echo "[!] Fatal: embedded version '$EMBEDDED_VERSION' does not match requested 'go${GO_VERSION}'"
    exit 1
fi

# 7. Copy Artifacts to Extension Source
echo "[*] Copying artifacts to extension directory..."
cp rclone.wasm "$SRC_DIR/rclone.wasm"

GOROOT_USED="$(go env GOROOT)"
for candidate in "$GOROOT_USED/lib/wasm/wasm_exec.js" "$GOROOT_USED/misc/wasm/wasm_exec.js"; do
    [ -f "$candidate" ] && { cp "$candidate" "$SRC_DIR/wasm_exec.js"; break; }
done
if [ ! -f "$SRC_DIR/wasm_exec.js" ]; then
    echo "[!] Fatal: wasm_exec.js not found in $GOROOT_USED"
    exit 1
fi

# 8. Generate the authoritative third-party license manifest.
# rclone.wasm statically links ~100 Go modules, and we redistribute it, so the
# exact per-module license set has to be recorded rather than approximated.
# This previously shelled out to go-licenses "best-effort" and therefore silently
# skipped on every build where it wasn't installed — which was every build, so
# the manifest THIRD_PARTY_LICENSES.md points at never existed. go-licenses also
# cannot analyse this target at all (google/go-licenses#128: it treats the ~220
# standard-library packages in the js/wasm graph as fatal "no module info"
# errors). The generator below derives the same information from `go list -deps`
# against the real build target, so it needs nothing beyond the Go toolchain
# already required here, and is a hard build step rather than best-effort.
echo "[*] Generating third-party license manifest..."
if [ -x "$PROJECT_DIR/tools/gen-license-manifest.sh" ]; then
    # rclone is the main module here, so `go list` reports no version for it;
    # hand the generator the pinned revision it was actually built from.
    MAIN_MODULE_VERSION="$RCLONE_COMMIT" \
        "$PROJECT_DIR/tools/gen-license-manifest.sh" . "$SRC_DIR/third-party-licenses.txt"
else
    echo "[!] tools/gen-license-manifest.sh missing or not executable — cannot"
    echo "    produce the license manifest required for redistribution."
    exit 1
fi

echo "[SUCCESS] rclone.wasm built successfully!"
