# Large RPC payloads: implementation tasks

Scope: this repository only. Keep `sendMessage`, existing public requesters and
typed proxies. Add opt-in large arguments/results and nested `Blob` support.
Minimal runtime dependencies: only approved dependencies (`js-base64` for v1
binary chunk transcoding); no durable resume, automatic method replay, or a
general-purpose JavaScript serializer.

## Delegation contract

Tasks run sequentially. Each subagent gets a detailed implementation brief and
an explicit Definition of Done. Each invocation makes one implementation pass
and one verification pass. If anything remains incomplete or a check fails,
return immediately with changes, command output, and concrete remaining work.
Do not enter an autonomous repair/retry loop or delegate further. The coordinator
reviews partial work and issues a separate, bounded follow-up when necessary.
Never commit, publish, or change files outside this repository.

## 1. Real MV3 test environment — completed

- Playwright Test for browser tests and pure TypeScript tests; no second runner.
- Minimal extension: service worker, one extension page, content script, local
  website fixture, isolated Chromium profile.
- Test the built library, with real Chrome messaging and no `chrome.*` mocks.
- Baseline coverage: typed calls, application errors, subscriptions, tab calls,
  multiple clients, existing requester variants.
- Runnable test/typecheck commands and ignored generated artifacts.

**Done:** baseline tests and typechecking pass against the existing library;
setup is reproducible and failure artifacts are available.

Verified: typecheck and 10 tests (3 pure, 7 real Chromium) pass. Coordinator
resolved the returned test typing issue and fixture setup/teardown defects.
Playwright 1.63 automatically records failure artifacts for the persistent
context; duplicate explicit tracing was removed after verifying this behavior.

## 2. JSON + Blob encoding — completed

- Private codec for JSON-compatible values and nested Blobs, preserving MIME,
  byte content, ordering, and distinguishing user data from transport metadata.
- Encode Blob bytes incrementally, with bounded JSON-safe fragments.
- Validate untrusted descriptors, indices, lengths, and allocation budgets.
- Cover Unicode, escaping, empty/nested Blobs, malformed input, and boundaries.

**Done:** focused runnable checks pass, the internal codec contract is documented
for transport integration, and no public API/runtime dependency is added.

Verified: typecheck and 9 pure tests pass (including 6 codec scenarios).
Private API lives in `src/codec.ts`: encodePayload, PayloadDecoder,
estimatePayloadMemory. JSON accounting is UTF-16 length
times two; Blob bytes are encoded only when a fragment is requested.

## 3. Opt-in chunked transport — completed

- One internal implementation shared by every requester path.
- Explicit protocol/version and backward-compatible constructor options.
- Sequential request upload and response download; small calls stay short.
- Execute handlers only after complete valid argument assembly; never replay a
  method automatically after an uncertain outcome.
- Bind transfers to callers and destination contexts; cover tabs/frames and
  current broadcast behavior. Reject unsupported external chunked transfers.
- Bounded temporary memory/concurrency, expiry, cleanup, and useful errors.

**Done:** JSON/Blob calls in both directions work through real Chrome messaging,
legacy baseline tests pass, and resource/error checks pass.

Verified: build/typecheck and 29 checks pass (17 pure, 12 real Chromium).
Public opt-in is `largePayloads: true | TransportOptions`. Defaults include
256 Ki code-unit/base64 chunks, 512 MiB accounted payload budget, 30s session
expiry and 10s per-message wait. Heavy/lifecycle acceptance remains task 4.

## 4. End-to-end acceptance and documentation — completed

- Actual >64 MiB request and response tests, run serially.
- Blob -> RPC -> IndexedDB -> RPC -> Blob with SHA-256/MIME/size assertions.
- Multiple clients/frames, navigation, page closure, deterministic SW stop,
  fresh-call recovery, and no automatic handler replay.
- README API/limits/error documentation and npm package content verification.

**Done:** the complete available suite and typecheck pass; packed library works
in the test fixture and contains no fixture/test files. Report any unmet
acceptance criterion explicitly rather than substituting mocks or skips.

Verified: 40 tests pass in Chromium 153.0.0.0, including 66 MiB native-limit
request/response cases, IndexedDB Blob SHA-256 roundtrip from a fresh page,
iframe ownership, closed-client expiry, targeted continuation after navigation,
genuine CDP worker stop and explicit recovery, no automatic replay, and browser
JSON/Blob smoke using the library extracted from its local npm tarball.

## 5. Coordinator review — completed

Review combined changes and test validity, preserve pre-existing user edits,
resolve partial tasks via bounded follow-ups, run final required checks, and
report exact outcomes. No commits or publishing.

Final verification: `npm test -- --max-failures=1` passes all 43 tests
(22 pure/package checks, 21 Chromium E2E), followed by passing
`npm run typecheck` and `git diff --check`. The suite took 20.8 seconds.
Final review added response call/transfer correlation checks, robust bounded
non-Error diagnostics, cleanup on failed validation, mandatory continuation
targets, and regressions for mismatched replies. The timeout/no-replay test now
waits for a persisted handler completion marker. Documentation uses the app's
async storage abstraction rather than nonexistent native IDB Promise methods.

Four specialist subagents were dispatched sequentially with detailed briefs.
Each incomplete attempt returned without a repair loop; separately authorized
follow-ups and coordinator corrections resolved the reported failures.

## 6. Replace manual base64 with js-base64 — completed

User-approved follow-up: adopt `js-base64@3.9.3` as a runtime dependency.
This explicitly supersedes the original zero-runtime-dependency restriction
for this package only. Keep the existing Chrome compatibility and v1 format.

- Agent 1: install the dependency and update the npm lockfile; replace manual
  byte/base64 conversion with `fromUint8Array` and `toUint8Array`.
- Preserve strict base64 input validation, empty values, Blob byte/MIME fidelity,
  bounded fragment reads, and `Uint8Array<ArrayBuffer>` compatibility.
- Update the dependency policy in `AGENTS.md` and this document.
- Add one focused regression only if existing checks do not cover the decoder's
  stricter accepted input format compared with the dependency.
- Run one build, typecheck, focused codec/transport test pass, and diff check.

**Definition of Done:** the approved dependency is installed and locked; manual
conversion loops are removed; validation and public behavior are preserved;
targeted checks pass; changed files and exact results are reported.

**Execution limit:** one implementation attempt and one verification pass.
At the first failed check or incomplete result, return immediately with the
partial changes, evidence, and remaining work. No autonomous fixes, retries,
dependency substitutions, or further delegation.

Agent 1 returned PARTIAL after one attempt: dependency integration, build, and
typecheck succeeded; focused tests stopped at 4 passed / 1 failed. The new
strict-base64 regression reused a decoder after a rejected chunk and therefore
failed on sequence validation. No repair or rerun was attempted. The codec
shrank from 696 to 681 lines. The coordinator assigned the isolated test repair
and final verification to Agent 2 as the next bounded task.

## 7. Isolate regression and independently verify integration — completed

Agent 2 starts only after Agent 1 returns and the coordinator reviews its result.
Authorized follow-up: isolate the new strict-base64 regression from the already
failed decoder, preferably by testing the existing validating helper directly.
Make this one test-only correction before beginning the verification pass.
Review the integration diff, dependency metadata, validation, and buffer typing.
Run `npm run typecheck`, `npm test -- --max-failures=1`, and `git diff --check`.
The full suite must exercise real Chromium Blob/IndexedDB roundtrips, large
messages, lifecycle behavior, and the packed npm artifact. Report the actual
test count, resolved dependency version, and codec line reduction.

**Definition of Done:** independent review finds no integration blocker; all
required checks pass; packed artifact/browser coverage ran; evidence and any
remaining limitations are returned to the coordinator. Apart from the explicitly
assigned regression correction, do not modify source or tests or repeat
successful checks.

**Execution limit:** one review and one verification pass. If a check fails,
stop and return immediately; do not repair, rerun, or delegate. The coordinator
records the final status and specifies a separate bounded follow-up if needed.

Agent 2 replaced the stateful decoder assertion with a direct strict-helper
regression and returned COMPLETE after one verification pass: typecheck passed;
`npm test -- --max-failures=1` passed all 42 checks (21 pure/package and 21
Chromium E2E) in 21.2 seconds; `git diff --check` passed. Packed npm artifact,
Blob/IndexedDB roundtrip, large-payload, and lifecycle coverage all ran.
Independent inspection confirmed `js-base64@3.9.3`, no transitive production
dependencies, and ordinary ArrayBuffer-backed results behind the localized
type assertion. The coordinator reviewed the final integration diff. Both
subagents ran sequentially; Agent 1 stopped on failure and Agent 2 performed
only the separately scoped correction and verification. No remaining blockers.

## 8. Replace manual JSON traversal — completed

Use `JSON.stringify` with a Blob-aware replacer instead of recursively copying
objects and arrays. Preserve v1 manifest fields, lazy Blob reads, path limits,
and unsupported-type rejection. Check repeated references, empty/special keys,
array holes, native `toJSON` behavior, getters, and depth/key/MIME boundaries.

**Definition of Done:** manual encoder recursion is removed; typecheck, the full
unit/browser/package suite, and the diff check pass; actual line savings are
recorded. Native JSON handles ordinary values and cycle rejection.

Verified: `npm run typecheck`, `npm test -- --max-failures=1` (44 passed in
21.7 seconds), and `git diff --check` passed. Two focused regressions cover
native traversal with Blob paths and preserved metadata boundaries. The codec
shrank from 681 to 622 lines (59 fewer); the recursive encoder and intermediate
object/array copies were removed.

## Initial workspace state

The user had already added `@playwright/test` ^1.63.0 to `package.json` and
`package-lock.json` before implementation. Preserve those edits.
