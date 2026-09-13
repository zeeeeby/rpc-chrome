# AGENTS.md — rpc-chrome Architecture & Development

A lightweight, strongly-typed RPC library for Chrome extension messaging (`chrome.runtime.sendMessage`, `chrome.tabs.sendMessage`).

## 1. Architecture and Module Responsibilities

The codebase is structured under `src/`:

- **`src/index.ts`**: Library root exporting public classes and type definitions (`Responder`, `Requester`, `RuntimeRequester`, `ContentScriptRequester`, `TransportOptions`, `LargePayloadOptions`, `ResponderConfig`, `RequesterOptions`).
- **`src/chrome.ts`**: Core public messaging classes:
  - `Responder<Methods>`: Registers handlers on `chrome.runtime.onMessage` (and optionally `onMessageExternal`), handles legacy simple requests, validates target responder and protocol versions, and coordinates v1 chunked transfer sessions.
  - `RuntimeRequester<Methods>`: Sends calls to the extension runtime / background service worker (`chrome.runtime.sendMessage`), supporting opt-in v1 large payloads.
  - `Requester<Methods>`: Dual-mode requester that calls either the runtime or specific tabs via `callTab(tabId, ...)`, or broadcasts to tabs matching `chrome.tabs.QueryInfo`.
  - `ContentScriptRequester<Methods>`: Broadcasts method calls to all tabs matching `chrome.tabs.QueryInfo` and aggregates per-tab responses `{ tabId, response }`.
- **`src/proxy.ts`**: TypeScript `Proxy` wrappers (`methodProxy`, `broadcastMethodProxy`) translating property accesses into typed RPC invocations.
- **`src/codec.ts`**: Private serialization layer for JSON values and nested `Blob`s:
  - `encodePayload`: Extracts nested Blobs and produces a manifest and a bounded chunk stream (`PayloadSource`).
  - `PayloadDecoder`: Sequentially reassembles incoming chunks, verifies descriptor budgets and chunk sequence integrity, and reconstructs objects with Blobs in their original object/array paths.
- **`src/transport.ts`**: Shared protocol implementation (`rpc-chrome/v1`):
  - Protocol envelopes (`call-inline`, `start-upload`, `upload-chunk`, `complete-upload`, `reply-inline`, `reply-stream`, `pull-chunk`, `release`, `abort`, `error`).
  - `ReceiverTransferManager`: Enforces aggregate accounted memory (`maxTotalBytes`), concurrency limits (`maxSessions`), and inactivity timeouts (`sessionTimeoutMs`).
  - `matchesCallerIdentity`: Authenticates callers against Chrome sender context (`extensionId`, `tabId`, `frameId`, `documentId`).
  - `sendV1Call`: Universal sender orchestrating upload chunking, response streaming, and error handling.

## 2. Testing Framework & Commands

The project uses **Playwright Test** exclusively for both pure unit tests and real browser extension E2E tests:

- **Unit tests** (`tests/pure/**/*.unit.test.ts`): Run without browser fixtures, testing exports, codec boundaries, prototype safety, transport limit validation, and npm package artifact contents.
- **E2E tests** (`e2e/**/*.spec.ts`): Launch real Chromium with an unpacked Manifest V3 extension, actual background service worker, extension pages, and content scripts on a local HTTP test server.

### Available Commands

- `npm run build`: Compiles `src/index.ts` with `tsup` into `dist/index.js` (CJS), `dist/index.mjs` (ESM), and `dist/index.d.ts`.
- `npm run build:fixture`: Compiles the test extension in `e2e/extension/` into `.e2e-extension/`.
- `npm run typecheck`: Runs `tsc --noEmit` across all source and test files.
- `npm test`: Full test pass (automatically builds dist and fixture, then runs all Playwright projects).
- `npm run test:e2e`: Runs only the browser E2E test project.
- `npm run test:e2e:headed`: Runs the browser E2E test project in headed mode.

Note: Running `npx playwright test` directly assumes that `npm run build` and `npm run build:fixture` have already been executed.

## 3. Engineering Invariants

- **Minimal runtime dependencies**: Only explicitly approved runtime dependencies (`js-base64` for v1 binary chunk transcoding) are permitted.
- **Fail-Closed Security**: External v1 chunked transfers are unsupported. Transfers are bound to Chrome sender identities (`documentId`).
- **No Automatic Replay**: Server handler execution is never replayed automatically after an uncertain network or timeout event.
- **Bounded Verification**: Verification tests must avoid piping multi-megabyte payloads through Playwright's CDP serialization layer, instead returning compact validation summaries from the browser context.
