# RPC Chrome

A simple library for typed messaging between different parts of a Chrome extension (background script, content script, popup, etc.) 

No more subscribing to Chrome events or parsing message results - just write your methods and call them directly with full TypeScript support.  

## Install
```bash
npm install rpc-chrome
# or
yarn add rpc-chrome
# or
pnpm add rpc-chrome
```

## Usage Example

`methods.ts`

```typescript
export function getData(key: string) {
	return storage.get(key)
}
export function setData(key: string, value: any) {
	return storage.set(key, value)
}
export function removeData(key: string) {
	return storage.remove(key)
}
```

`background.ts`

```typescript
import * as methods from "./methods"

// Methods type is automatically inferred from the imported module
export type Methods = typeof methods

// Create a handler for incoming messages
const methodsApi = new Responder<Methods>("methods")

// Register all methods from the imported module
methodsApi.subscribeUniversal(async (name, args) => {
	const method = methods[name] as (...args: any[]) => any

	return method(...args)
})

export type Events = {
	dataChanged: (key: string) => void
	userLoggedIn: (userData: { id: string; name: string }) => void
	themeChanged: (theme: "light" | "dark") => void
}

const events = new Requester<Events>("events", {})

// Send events from background script
events.proxy.dataChanged("user-settings")
events.proxy.userLoggedIn({ id: "123", name: "John" })
events.proxy.themeChanged("dark")
```

`popup.ts, options.ts, content-script.ts`

```typescript
const events = new Responder<Events>("events")
const methods = new Requester<Methods>("methods")

// Subscribe to events
events.subscribe("dataChanged", async (key) => {
	// Update data
	const newData = await methods.proxy.getData(key)
	// ...
})

events.subscribe("userLoggedIn", (userData) => {
	// Update UI with user information
})

events.subscribe("themeChanged", (theme) => {
	// Apply new theme
	document.body.classList.toggle("dark", theme === "dark")
})
```

## Configuration Options

### Large Payloads & Nested Blobs (Opt-in)

Chrome's native messaging enforces a strict ~64 MiB limit on single messages and does not natively serialize `Blob` instances through `sendMessage`. `rpc-chrome` provides an opt-in v1 chunked transport that splits large JSON payloads and nested `Blob`s into bounded fragments.

To enable large payload support, pass `{ largePayloads: true }` or custom `TransportOptions`:

```typescript
import { Responder, Requester, RuntimeRequester, ContentScriptRequester } from "rpc-chrome"

// 1. Responder
const api = new Responder<Methods>("methods", {
  largePayloads: true,
})

// 2. RuntimeRequester (e.g. extension page, popup, or options -> background SW)
const client = new RuntimeRequester<Methods>("methods", {
  largePayloads: true,
})

// 3. Requester without tab query (sends via chrome.runtime.sendMessage)
const req = new Requester<Methods>("methods", undefined, {
  largePayloads: true,
})

// 4. Requester with tab query (filters tabs and broadcasts)
const tabReq = new Requester<Methods>("methods", { active: true, currentWindow: true }, {
  largePayloads: true,
})

// 5. ContentScriptRequester (calls all matching tabs and collects per-tab responses)
const csReq = new ContentScriptRequester<Methods>("methods", { active: true }, {
  largePayloads: true,
})
```

#### Transport Options

You can customize transport limits by passing a `TransportOptions` object to `largePayloads`:

```typescript
const api = new Responder<Methods>("methods", {
  largePayloads: {
    chunkSize: 256 * 1024,      // 256 Ki code units / base64 chars (max: 1 Mi)
    maxTotalBytes: 512 * 1024 * 1024, // 512 MiB total accounted size (jsonLength * 2 + blob bytes)
    maxJsonLength: 128 * 1024 * 1024, // 128 Mi code units (allows strings >64 MiB)
    maxChunks: 100_000,         // Maximum chunks per transfer
    maxBlobs: 10_000,           // Maximum Blobs per transfer
    sessionTimeoutMs: 30_000,   // Inactivity timeout for chunk transfer sessions
    messageTimeoutMs: 10_000,   // Timeout waiting for peer response per message exchange
    maxSessions: 100,           // Maximum concurrent active transfer sessions
  },
})
```

#### Nested Blob Storage Example

Blobs retain their bytes, size, and MIME type inside objects and arrays. Expose your existing asynchronous IndexedDB storage methods directly:

```typescript
// Background Service Worker
import { mediaStorage } from "./storage" // Your async saveMedia/getMedia implementation
export type StorageMethods = typeof mediaStorage
const storageApi = new Responder<StorageMethods>("storage", { largePayloads: true })
storageApi.subscribe("saveMedia", mediaStorage.saveMedia)
storageApi.subscribe("getMedia", mediaStorage.getMedia)

// Extension Page or Content Script
const storageClient = new RuntimeRequester<StorageMethods>("storage", { largePayloads: true })

const photoBlob = new Blob([binaryData], { type: "image/png" })
await storageClient.proxy.saveMedia({
  id: "photo-1",
  file: photoBlob,
  tags: ["vacation", "2026"],
})

const result = await storageClient.proxy.getMedia("photo-1")
if (result) {
  console.log(result.file instanceof Blob) // true
  console.log(result.file.type)           // "image/png"
}
```

#### Behavior and Guarantees

- **No Automatic Method Replay & Timeout Semantics:** `messageTimeoutMs` (default: 10,000ms) measures the wait time for the peer's exchange response, which includes server handler execution for final completion. Callers running long operations should increase `messageTimeoutMs`. Crucially, a client-side timeout or connection drop does *not* cancel or prove that a server handler did not already commit side effects; `rpc-chrome` never automatically retries or replays method calls.
- **Service Worker Lifecycle:** Transfers are in memory and cannot resume after the worker stops. A new explicit call can wake the worker and start a fresh operation. Register responders synchronously when the worker starts.
- **Single Logical Responder Recommendation:** Because `chrome.runtime.sendMessage` broadcasts initial connection messages to all active listeners and resolves on the first response, extensions should maintain a single logical `Responder` per channel to avoid race conditions during initial handshake.
- **Fail-Closed Caller Identity:** Multi-chunk transfers are tied to the caller's verified Chrome sender context (`tabId`, `frameId`, and Chrome `documentId`). Cross-document callers cannot hijack, upload chunks, or cancel in-flight transfers belonging to another document.
- **External Messages Limitation:** External chunked transfers (`chrome.runtime.onMessageExternal`) are explicitly unsupported in `rpc-chrome/v1` and reject immediately.
- **Supported Types & Memory Accounting:** Supported data types are JSON-compatible primitives/objects/arrays and nested `Blob`s. `Map`, `Set`, cyclic structures, and arbitrary classes are not supported. Memory budgets (`maxTotalBytes`) account for estimated payload size (`jsonLength * 2 + totalBlobBytes`) per receiver transfer manager, not a global process heap limit. Payloads are reassembled in memory before handler invocation; this is not an infinite streaming pipeline.
- **Serialization limits:** Root `undefined` is preserved in opt-in mode; undefined object properties are omitted and undefined array entries become `null`. Empty Blobs are supported. Files are treated as Blobs (filename/lastModified are not preserved). Nesting is limited to 256 levels; Blob MIME strings to 256 characters and Blob-path object keys to 512 characters.
- **Disposal:** Call `responder.dispose()` when removing a responder from a long-lived context; it unregisters listeners and discards its pending transfers.

### External Messages

When creating a Responder, you can enable handling of external messages from other extensions:

```typescript
const methodsApi = new Responder<Methods>("methods", { external: true })
```

This allows other extensions or websites to call your methods using `chrome.runtime.sendMessage`.

### Tab Filtering

When creating a Requester, you can specify `chrome.tabs.QueryInfo` to filter specific tabs:

```typescript
const events = new Requester<Events>("events", {
	active: true, 
	currentWindow: true, 
	url: ["*://*.github.com/*"], 
})
```

This allows you to send messages only to tabs that match specific criteria.

## Features

-   Full method and argument typing
-   Async operation support
-   Automatic data serialization
-   Simple proxy interface for method calls
-   Support for multiple handlers per method

## Testing

The project uses Playwright Test to execute both pure TypeScript tests and realistic end-to-end browser tests against an unpacked Manifest V3 extension loaded into Chromium.

### Prerequisites

Install Playwright's Chromium browser binary:

```bash
npx playwright install chromium
```

### Commands

- `npm run typecheck`: Runs TypeScript type checking (`tsc --noEmit`) across library sources and test suites.
- `npm run build`: Compiles the library using `tsup` into CommonJS, ESM, and type declarations (`dist/`).
- `npm test`: Builds the library and fixture, then runs the full test suite (pure TypeScript and E2E browser tests).
- `npm run test:e2e`: Runs only the E2E browser test suite in headless mode.
- `npm run test:e2e:headed`: Runs the E2E browser test suite in headed mode for visual debugging.
