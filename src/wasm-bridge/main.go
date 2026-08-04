// OmniFiles - ChromeOS Rclone Integration
// Copyright (c) 2026 Markus Litz
// Licensed under the MIT License. See LICENSE file in the project root for details.

// Rclone as a wasm library
//
// This library exports the core rc functionality for Chrome Extension Service Workers

//go:build js

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"syscall/js"
	"time"

	"github.com/rclone/rclone/fs"
	"github.com/rclone/rclone/fs/config"
	"github.com/rclone/rclone/fs/operations"
	"github.com/rclone/rclone/fs/rc"

	// Core functionality we need
	_ "github.com/rclone/rclone/fs/sync"

	// Import backends
	_ "github.com/rclone/rclone/backend/crypt"
	_ "github.com/rclone/rclone/backend/drive"
	_ "github.com/rclone/rclone/backend/dropbox"
	_ "github.com/rclone/rclone/backend/googlecloudstorage"
	_ "github.com/rclone/rclone/backend/googlephotos"
	_ "github.com/rclone/rclone/backend/memory"
	_ "github.com/rclone/rclone/backend/onedrive"
	_ "github.com/rclone/rclone/backend/s3"
)

var (
	jsJSON js.Value
)

// errorValue turns an error into a js.Value
func errorValue(method string, in js.Value, err error) js.Value {
	fs.Errorf(nil, "rc: %q: error: %v", method, err)
	// Adjust the error return for some well known errors
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, fs.ErrorDirNotFound) || errors.Is(err, fs.ErrorObjectNotFound):
		status = http.StatusNotFound
	case rc.IsErrParamInvalid(err) || rc.IsErrParamNotFound(err):
		status = http.StatusBadRequest
	}
	return js.ValueOf(map[string]interface{}{
		"status": status,
		"error":  err.Error(),
		"input":  in,
		"path":   method,
	})
}

// rcCallback is a callback for javascript to access the api.
// It returns a standard JavaScript Promise because rclone operations
// (like operations/list or stat) make network requests which use Go's
// fetch() wrapper. If we block the main thread, fetch() promises can never
// resolve, resulting in a Go deadlock (all goroutines are asleep!).
func rcCallback(this js.Value, args []js.Value) interface{} {
	// Create a Promise executor
	handler := js.FuncOf(func(this js.Value, pArgs []js.Value) interface{} {
		resolve := pArgs[0]
		reject := pArgs[1]

		// Run the actual work in a goroutine
		go func() {
			ctx := context.Background()

			if len(args) != 2 {
				reject.Invoke(errorValue("", js.Undefined(), errors.New("need two parameters to rc call")))
				return
			}

			method := args[0].String()
			log.Printf("rcCallback invoked. method=%s", method)
			inRaw := args[1]
			var in = rc.Params{}

			switch inRaw.Type() {
			case js.TypeNull:
			case js.TypeObject:
				inJSON := jsJSON.Call("stringify", inRaw).String()
				err := json.Unmarshal([]byte(inJSON), &in)
				if err != nil {
					reject.Invoke(errorValue(method, inRaw, fmt.Errorf("couldn't unmarshal input: %w", err)))
					return
				}
			default:
				reject.Invoke(errorValue(method, inRaw, errors.New("in parameter must be null or object")))
				return
			}

			call := rc.Calls.Get(method)
			if call == nil {
				reject.Invoke(errorValue(method, inRaw, fmt.Errorf("method %q not found", method)))
				return
			}

			out, err := call.Fn(ctx, in)
			if err != nil {
				reject.Invoke(errorValue(method, inRaw, fmt.Errorf("method call failed: %w", err)))
				return
			}

			if out == nil {
				resolve.Invoke(js.Undefined())
				return
			}

			var out2 map[string]interface{}
			err = rc.Reshape(&out2, out)
			if err != nil {
				reject.Invoke(errorValue(method, inRaw, fmt.Errorf("result reshape failed: %w", err)))
				return
			}

			resolve.Invoke(js.ValueOf(out2))
		}()

		return nil
	})

	return js.Global().Get("Promise").New(handler)
}

// configInjectCallback writes config key-value pairs directly into rclone's
// in-memory config storage. This bypasses the interactive config/create
// flow which tries to start an OAuth server and deadlocks in WASM.
//
// Usage from JS: self.configInject("remoteName", { type: "drive", token: "...", ... })
func configInjectCallback(this js.Value, args []js.Value) interface{} {
	if len(args) != 2 {
		return js.ValueOf(map[string]interface{}{
			"error": "configInject needs exactly 2 arguments: name (string), parameters (object)",
		})
	}

	name := args[0].String()
	params := args[1]

	if params.Type() != js.TypeObject {
		return js.ValueOf(map[string]interface{}{
			"error": "second argument must be an object",
		})
	}

	// Get the keys of the JS object
	keys := js.Global().Get("Object").Call("keys", params)
	keyCount := keys.Length()

	log.Printf("configInject: injecting %d keys for remote %q", keyCount, name)

	for i := 0; i < keyCount; i++ {
		key := keys.Index(i).String()
		value := params.Get(key).String()
		config.FileSetValue(name, key, value)
	}

	log.Printf("configInject: remote %q configured successfully", name)

	return js.ValueOf(map[string]interface{}{
		"status": "ok",
		"name":   name,
		"keys":   keyCount,
	})
}

// fileReadCallback reads a byte range from a remote file and returns
// a Uint8Array to JavaScript via a Promise.
//
// Usage from JS: await self.fileRead("remote:", "path/to/file", offset, length)
// - fsPath:   the rclone remote with trailing colon, e.g. "ziraInfo:"
// - filePath: path within the remote, e.g. "documents/report.pdf"
// - offset:   byte offset to start reading from (int)
// - length:   number of bytes to read (int)
//
// Returns a Uint8Array containing exactly the bytes read (may be smaller than
// length if the file ends earlier). The Uint8Array is created in WASM linear
// memory and copied to the JS heap via js.CopyBytesToJS, so no JSON
// encoding is needed — this is safe and efficient for arbitrary binary data.
func fileReadCallback(this js.Value, args []js.Value) interface{} {
	handler := js.FuncOf(func(this js.Value, pArgs []js.Value) interface{} {
		resolve := pArgs[0]
		reject := pArgs[1]

		go func() {
			if len(args) != 4 {
				reject.Invoke(js.ValueOf("fileRead needs 4 arguments: fsPath, filePath, offset, length"))
				return
			}

			fsPath := args[0].String()   // e.g. "ziraInfo:"
			filePath := args[1].String() // e.g. "folder/file.txt"
			offset := int64(args[2].Int())
			length := args[3].Int()

			log.Printf("fileRead: %s%s offset=%d length=%d", fsPath, filePath, offset, length)

			ctx := context.Background()

			// Create or get a cached Fs for this remote
			f, err := fs.NewFs(ctx, fsPath)
			if err != nil {
				reject.Invoke(js.ValueOf("fileRead: fs error: " + err.Error()))
				return
			}

			// Get the object (file entry) from the Fs
			obj, err := f.NewObject(ctx, filePath)
			if err != nil {
				reject.Invoke(js.ValueOf("fileRead: object error: " + err.Error()))
				return
			}

			// Open the file with a range option so the backend only downloads
			// the exact bytes we need (avoids downloading the whole file).
			// Named readCloser, not the conventional rc: that would shadow the
			// imported fs/rc package for the rest of this scope.
			readCloser, err := obj.Open(ctx, &fs.RangeOption{
				Start: offset,
				End:   offset + int64(length) - 1,
			})
			if err != nil {
				reject.Invoke(js.ValueOf("fileRead: open error: " + err.Error()))
				return
			}
			defer readCloser.Close()

			// Read exactly length bytes (or fewer at EOF)
			buf := make([]byte, length)
			n, err := io.ReadFull(readCloser, buf)
			if err != nil && err != io.ErrUnexpectedEOF {
				reject.Invoke(js.ValueOf("fileRead: read error: " + err.Error()))
				return
			}
			buf = buf[:n]

			// Copy bytes directly into a JS Uint8Array (no JSON/base64 overhead)
			jsArr := js.Global().Get("Uint8Array").New(n)
			js.CopyBytesToJS(jsArr, buf)

			log.Printf("fileRead: delivered %d bytes for %s%s", n, fsPath, filePath)
			resolve.Invoke(jsArr)
		}()

		return nil
	})

	return js.Global().Get("Promise").New(handler)
}

type progressReader struct {
	r          io.Reader
	total      int
	read       int
	jsCallback js.Value
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	pr.read += n
	if pr.jsCallback.Type() == js.TypeFunction {
		pr.jsCallback.Invoke(pr.read, pr.total)
	}
	return n, err
}

// fileWriteCallback uploads a file to the remote from a JS Uint8Array
// Usage from JS: await self.fileWrite("remote:", "path/to/file", uint8Array, progressCallback)
func fileWriteCallback(this js.Value, args []js.Value) interface{} {
	handler := js.FuncOf(func(this js.Value, pArgs []js.Value) interface{} {
		resolve := pArgs[0]
		reject := pArgs[1]

		go func() {
			if len(args) < 3 {
				reject.Invoke(js.ValueOf("fileWrite needs at least 3 arguments: fsPath, filePath, uint8Array"))
				return
			}

			fsPath := args[0].String()
			filePath := args[1].String()
			jsData := args[2]
			var progressCb js.Value
			if len(args) >= 4 {
				progressCb = args[3]
			}

			if jsData.Type() != js.TypeObject {
				reject.Invoke(js.ValueOf("fileWrite: data must be a Uint8Array"))
				return
			}

			length := jsData.Get("byteLength").Int()
			buf := make([]byte, length)
			js.CopyBytesToGo(buf, jsData)

			log.Printf("fileWrite: %s%s length=%d", fsPath, filePath, length)

			ctx := context.Background()

			f, err := fs.NewFs(ctx, fsPath)
			if err != nil {
				reject.Invoke(js.ValueOf("fileWrite: fs error: " + err.Error()))
				return
			}

			// Wrap the buffer reader in our custom progress tracker
			baseReader := bytes.NewReader(buf)
			var reader io.Reader = baseReader

			if progressCb.Type() == js.TypeFunction {
				reader = &progressReader{
					r:          baseReader,
					total:      length,
					read:       0,
					jsCallback: progressCb,
				}
			}

			// Rcat uploads the data directly from the reader into the filePath
			closer := io.NopCloser(reader)
			_, err = operations.Rcat(ctx, f, filePath, closer, time.Now(), nil)
			if err != nil {
				reject.Invoke(js.ValueOf("fileWrite: upload error: " + err.Error()))
				return
			}

			log.Printf("fileWrite: successfully wrote %d bytes to %s%s", length, fsPath, filePath)
			resolve.Invoke(js.Undefined())
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

// jsStreamReader is an io.Reader that pulls chunks from a JS ReadableStream reader
// (the object returned by stream.getReader()). Each Read() call synchronously
// awaits one read() chunk from the JS side via a Go channel bridge.
// This is the key piece that allows true streaming without buffering the full file.
type jsStreamReader struct {
	ctx        context.Context
	cancel     context.CancelFunc
	jsReader   js.Value // the JS ReadableStreamDefaultReader
	buf        []byte   // leftover bytes from the last chunk not yet consumed
	done       bool
	totalRead  int
	totalSize  int
	progressCb js.Value
}

// Read implements io.Reader by pulling the next chunk from the JS ReadableStream.
// Because JS Promises must be awaited asynchronously, we spin a goroutine for the
// Promise and block on a channel – this is safe because fileWriteStream already runs
// in its own goroutine (not on the JS event loop goroutine).
func (r *jsStreamReader) Read(p []byte) (int, error) {
	// If we still have leftover bytes from the previous chunk, serve them first.
	if len(r.buf) > 0 {
		n := copy(p, r.buf)
		r.buf = r.buf[n:]
		r.totalRead += n
		if r.progressCb.Type() == js.TypeFunction {
			r.progressCb.Invoke(r.totalRead, r.totalSize)
		}
		return n, nil
	}

	if r.done {
		return 0, io.EOF
	}

	if err := r.ctx.Err(); err != nil {
		return 0, err
	}

	// Channel to receive the result of the JS read() promise
	type readResult struct {
		data []byte
		done bool
		err  string
	}
	ch := make(chan readResult, 1)

	// Call reader.read() which returns a Promise<{value, done}>
	readPromise := r.jsReader.Call("read")

	onFulfilled := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		result := args[0]
		doneVal := result.Get("done").Bool()
		if doneVal {
			ch <- readResult{done: true}
			return nil
		}
		value := result.Get("value") // Uint8Array
		byteLen := value.Get("byteLength").Int()
		chunk := make([]byte, byteLen)
		js.CopyBytesToGo(chunk, value)
		ch <- readResult{data: chunk}
		return nil
	})
	onRejected := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		msg := "stream read error"
		if len(args) > 0 {
			msg = args[0].String()
		}
		ch <- readResult{err: msg}
		return nil
	})
	readPromise.Call("then", onFulfilled).Call("catch", onRejected)

	res := <-ch
	onFulfilled.Release()
	onRejected.Release()

	if res.err != "" {
		return 0, fmt.Errorf("%s", res.err)
	}
	if res.done {
		r.done = true
		return 0, io.EOF
	}

	// Copy as much as fits into p, buffer the rest for the next Read call
	n := copy(p, res.data)
	if n < len(res.data) {
		r.buf = res.data[n:]
	}
	r.totalRead += n
	if r.progressCb.Type() == js.TypeFunction {
		r.progressCb.Invoke(r.totalRead, r.totalSize)
	}
	return n, nil
}

// fileWriteStreamCallback streams chunks from a JS ReadableStream directly into
// rclone via operations.Rcat. No full-file buffer is held in Go memory.
//
// Usage from JS:
//
//	await self.fileWriteStream("remote:", "path/to/file", readableStream, totalBytes, progressCb)
//
// - fsPath:       rclone remote with trailing colon, e.g. "gdrive:"
// - filePath:     path within remote, e.g. "videos/movie.mkv"
// - stream:       a JS ReadableStream of Uint8Array chunks
// - totalBytes:   total file size (integer, used for progress reporting only)
// - progressCb:   optional JS function(uploaded, total) called on progress
func fileWriteStreamCallback(this js.Value, args []js.Value) interface{} {
	handler := js.FuncOf(func(this js.Value, pArgs []js.Value) interface{} {
		resolve := pArgs[0]
		reject := pArgs[1]

		go func() {
			if len(args) < 3 {
				reject.Invoke(js.ValueOf("fileWriteStream needs at least 3 args: fsPath, filePath, stream"))
				return
			}

			fsPath := args[0].String()
			filePath := args[1].String()
			jsStream := args[2]
			totalBytes := 0
			if len(args) >= 4 {
				totalBytes = args[3].Int()
			}
			var progressCb js.Value
			if len(args) >= 5 {
				progressCb = args[4]
			}

			if jsStream.Type() != js.TypeObject {
				reject.Invoke(js.ValueOf("fileWriteStream: stream argument must be a ReadableStream object"))
				return
			}

			log.Printf("fileWriteStream: %s%s totalBytes=%d", fsPath, filePath, totalBytes)

			// Get the JS reader from the stream
			jsReader := jsStream.Call("getReader")

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			sr := &jsStreamReader{
				ctx:        ctx,
				cancel:     cancel,
				jsReader:   jsReader,
				totalSize:  totalBytes,
				progressCb: progressCb,
			}

			f, err := fs.NewFs(ctx, fsPath)
			if err != nil {
				reject.Invoke(js.ValueOf("fileWriteStream: fs error: " + err.Error()))
				return
			}

			_, err = operations.Rcat(ctx, f, filePath, io.NopCloser(sr), time.Now(), nil)
			if err != nil {
				reject.Invoke(js.ValueOf("fileWriteStream: upload error: " + err.Error()))
				return
			}

			log.Printf("fileWriteStream: successfully streamed %d bytes to %s%s", sr.totalRead, fsPath, filePath)
			resolve.Invoke(js.Undefined())
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func main() {
	log.Printf("Running rclone Service Worker Bridge on goos/goarch = %s/%s", runtime.GOOS, runtime.GOARCH)

	global := js.Global()
	if global.IsUndefined() {
		log.Fatalf("Didn't find Global - not running in JS environment")
	}

	jsJSON = global.Get("JSON")
	if jsJSON.IsUndefined() {
		log.Fatalf("can't find JSON component")
	}

	// Set rc function on the global object (which is `self` in a Service Worker)
	global.Set("rc", js.FuncOf(rcCallback))

	// Set configInject function - direct in-memory config writing (no OAuth)
	global.Set("configInject", js.FuncOf(configInjectCallback))

	// Set fileRead function - ranged binary reads from remote files
	global.Set("fileRead", js.FuncOf(fileReadCallback))

	// Set fileWrite function - uploads a binary file to the remote (buffered, small files)
	global.Set("fileWrite", js.FuncOf(fileWriteCallback))

	// Set fileWriteStream function - streams a ReadableStream directly to the remote (large files)
	global.Set("fileWriteStream", js.FuncOf(fileWriteStreamCallback))

	// Wrap fs.ConfigFileSet to notify Javascript of config changes
	origConfigFileSet := fs.ConfigFileSet
	fs.ConfigFileSet = func(section, key, value string) (err error) {
		log.Printf("ConfigFileSet intercepted: section=%s, key=%s", section, key)
		err = origConfigFileSet(section, key, value)
		if err == nil {
			g := js.Global()
			onConfigChanged := g.Get("onConfigChanged")
			if !onConfigChanged.IsUndefined() && onConfigChanged.Type() == js.TypeFunction {
				// Invoke in a goroutine to not block Go execution
				go onConfigChanged.Invoke(section, key, value)
			}
		}
		return err
	}

	// Resolve the promise so JS knows it is ready
	rcValidResolve := global.Get("rcValidResolve")
	if !rcValidResolve.IsUndefined() && rcValidResolve.Type() == js.TypeFunction {
		rcValidResolve.Invoke()
	} else {
		log.Println("rcValidResolve function not found in global scope. Proceeding anyway.")
	}

	// Wait forever
	select {}
}
