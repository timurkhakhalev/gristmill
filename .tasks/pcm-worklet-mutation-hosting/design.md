# PCM worklet mutation hosting — design proposal

- Status: **proposal, not approved**. No extraction happens until the owner approves.
- Issue: #406 (parent #346, deferral decision #372).
- Date: 2026-10-19.

## 1. Problem

`src/helpers/meetingAudioPipeline.ts` holds the PCM worklet as JavaScript inside a template string (about L36–199). The code builds a Blob URL and loads it with `audioWorklet.addModule` (L271). The three values `MEETING_AUDIO_BUFFER_SIZE`, `MAX_UNACKNOWLEDGED_CAPTURE_FRAMES` and `MAX_CAPTURE_ACK_AGE_MS` are interpolated into the string. Two focused tests read the `.ts` file with `fs`, cut the template with a regex, substitute the values, and run the result in `node:vm`.

Stryker cannot mutate statements inside a string literal. The worklet logic is therefore not in the mutation program.

## 2. Current constraints (measured in this checkout)

- The pipeline is **renderer-only**. `tsconfig.main.json` does not include `meetingAudioPipeline.ts`. Consumers: `src/components/MeetingRecordingMount.tsx`, `src/stores/meetingRecordingStore.ts`, and `test/cases/recording/integration/meetingAudioPipeline.test.ts`.
- Vite root is `src` (`src/vite.config.mjs`), output `src/dist`, `base: "./"`. The renderer is served by the dev server in development and loaded from `src/dist/index.html` with `file://` in production (`src/helpers/windowManager.ts`).
- `electron-builder.json` ships `src/dist/**/*` and `dist-main/**/*`; `src/dist` is git-ignored.
- `src/index.html` has **no Content-Security-Policy meta**. The control-panel window sets `webSecurity: false` (`src/helpers/windowConfig.ts`).
- The worklet already loads from a **Blob URL**. That path works in development and in the packaged app. No protocol registration or file-URL module load is involved.
- `src/vite-env.d.ts` references `vite/client`, so `?raw` imports are typed in the renderer graph. The test tsconfig does not load `vite/client`; tests must not import `?raw`.

## 3. Options

| Option | How it loads | Assessment |
| --- | --- | --- |
| A. Real `.js` source, imported as `?raw`, still Blob URL | Vite inlines the file text into the renderer bundle; the pipeline substitutes the three values and creates the same Blob URL | **Recommended.** Runtime path is unchanged. No CSP, protocol, packaging or preload change. The real file is a valid Stryker target. |
| B. Real `.js` asset, `addModule(new URL(...))` | Vite emits a hashed asset; `audioWorklet.addModule(assetUrl)` | Higher risk. In the packaged app the document origin is `file://`; worklet module loading from `file://` is not verified here, and `base: "./"` makes URL rewriting fragile. It also needs a packaged spike before approval. |
| C. Bundled `.ts` worklet module | Vite/worker build emits an ES module; `addModule` loads it | Same `file://` risk as B, plus a second build entry and a new bundle contract. The worklet imports nothing today, so bundling adds cost without gain. |

Option A keeps the proven Blob path and moves only the **source of the text**.

## 4. Recommended design (Option A)

### 4.1 Module layout

- New file: `src/worklets/meetingPcmProcessor.js` (plain JavaScript, no imports).
- Move the template body verbatim. Replace the three `${...}` interpolations with identifier tokens:
  - `__MEETING_AUDIO_BUFFER_SIZE__`
  - `__MAX_UNACKNOWLEDGED_CAPTURE_FRAMES__`
  - `__MAX_CAPTURE_ACK_AGE_MS__`
- The tokens are valid JavaScript identifiers. The file parses before substitution, so Stryker and editors can parse it. Stryker does not mutate the tokens.
- `SAMPLE_RATE = 24000`, `MAX_ACK_AGE_FRAMES`, the processor class and `registerProcessor` stay in the file.

`meetingAudioPipeline.ts` keeps the single source of truth for the values:

```ts
import workletSource from "../worklets/meetingPcmProcessor.js?raw";

const code = workletSource
  .replaceAll("__MEETING_AUDIO_BUFFER_SIZE__", String(MEETING_AUDIO_BUFFER_SIZE))
  .replaceAll("__MAX_UNACKNOWLEDGED_CAPTURE_FRAMES__", String(MAX_UNACKNOWLEDGED_CAPTURE_FRAMES))
  .replaceAll("__MAX_CAPTURE_ACK_AGE_MS__", String(MAX_CAPTURE_ACK_AGE_MS));

blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
```

`getMeetingWorkletBlobUrl`, `primeMeetingWorklet`, `addModule` and the processor name do not change.

### 4.2 Build, bundle and packaging

- **Vite:** `?raw` is built in. The file text becomes a string in the renderer bundle. No new asset, entry, plugin or `assetsInclude` rule.
- **Dev vs packaged:** both use the same inlined string. The Blob URL is created at runtime, so the dev server origin and the packaged `file://` origin behave as they do today.
- **electron-builder:** no change. The text is inside `src/dist/**/*`, which the config already ships. No `extraResources`, `asarUnpack`, preload or protocol change.
- **Minification:** Vite may minify the bundle, but the raw string is data and stays intact. Mutation testing does not use the bundle; Stryker instruments the source file. Bundle minification is therefore irrelevant to mutant behavior.
- **Type boundary:** `?raw` requires `vite/client` types. The pipeline must stay in the renderer graph. `tsconfig.main.json` already excludes it. Do not import the pipeline from main code.

### 4.3 CSP and protocol

- Today: no CSP meta; the existing Blob worklet already runs. Option A adds no new origin, scheme or permission.
- If a CSP is added later, the worklet needs `blob:` in the directive that governs worklets in the target Chromium (`script-src`, and `worker-src` for worker scripts). Record this when a CSP is introduced.
- No custom protocol registration is needed. The app already registers `gristmill://` for deep links; that is unrelated.

## 5. Test seam

**Recommendation: keep the `node:vm` harness; replace only the source extraction.**

- `test/cases/recording/unit/meetingPcmProcessor.test.ts`: replace the `fs` + template-regex block with `fs.readFileSync("src/worklets/meetingPcmProcessor.js")` and the three `replaceAll` calls.
- `test/cases/recording/unit/meetingCaptureBackpressure.test.ts`: the same change. Keep the real constants imported from `meetingCaptureWriteQueue.ts`.
- Keep `node:vm`: the worklet needs `AudioWorkletProcessor`, `currentFrame` and `registerProcessor` globals. A plain import cannot provide them without changing the production file into a factory, which is a larger design.
- The harness then executes the exact file that Stryker mutates. Stryker copies the project into its sandbox and runs the tests there; the `__dirname`-relative read resolves inside the sandbox. Confirm this in the registration dry run.

This keeps the tests source-based, but no longer regex-dependent. The regex is the fragile part; the file read is the durable part.

## 6. Mutation-testability argument

Once the worklet is a real file:

- Register a target, for example `recording:meeting-pcm-processor`:
  - `mutate: ["src/worklets/meetingPcmProcessor.js"]`
  - `testFiles: ["test/cases/recording/unit/meetingPcmProcessor.test.ts", "test/cases/recording/unit/meetingCaptureBackpressure.test.ts"]`
  - `directDependencies: ["src/helpers/meetingCaptureWriteQueue.ts"]` (the tests inject those constants)
  - `artifactDirectory: "reports/mutation/recording/meeting-pcm-processor"`
- Stryker's TypeScript instrumenter parses plain JavaScript. With `coverageAnalysis: off`, every mutant runs both focused files. The files read the mutated copy from the sandbox, so each mutant changes the executed source.
- Rough size: 164 source lines, 30 `if` statements, 7 logical operators, 10 equality operators, 17 string literals, 21 booleans, 8 optional chains, 2 `Math.min/max`. Expected mutant classes: ConditionalExpression (~60), BlockStatement (~20), BooleanLiteral (~21), StringLiteral (~17), EqualityOperator (~10), LogicalOperator (~7), OptionalChaining (~8), arithmetic (~10), array/object/arrow (~6). **Rough estimate: 120–160 mutants.** Measure the exact count in the registration dry run. The estimate is not a score and not a target.
- Registration is a **separate follow-up** (registry entry, `mutationRunner` assertion, target map, cloud dry/full pair). It is not part of the extraction PR or this design PR.

## 7. Owner decision point

**No extraction happens until the owner approves this design.** The owner is asked to approve:

1. Hosting the worklet as a real plain-JavaScript file at `src/worklets/meetingPcmProcessor.js`, loaded through a `?raw` import and the existing Blob URL. The runtime loading path does not change.
2. The token substitution for the three values, with `meetingCaptureWriteQueue.ts` and `meetingAudioPipeline.ts` staying the source of truth.
3. Replacing the source-regex extraction in the two worklet tests with a direct file read, while keeping the `node:vm` harness.
4. The follow-up mutation target scope in section 6, registered separately with its own cloud dry/full pair.

Approval of this design does **not** approve the extraction itself, test edits, a target registration or a cloud run. Those come in later PRs.

## 8. Non-goals

- No extraction and no production code change in this PR.
- No test change in this PR.
- No target registration and no cloud mutation run.
- No ADR. An ADR belongs here only after the owner accepts the design and the extraction lands.
- No performance change. The worklet logic is unchanged.

## 9. Risks and limitations

- `?raw` is a renderer-only import. If `meetingAudioPipeline.ts` ever joins the main graph, `tsc` for main cannot resolve it. Keep the pipeline renderer-only.
- The extraction must move the code verbatim. The two tests and the pipeline integration test are the behavior check. A packaged smoke test is still needed because Blob/Worklet behavior is a runtime property.
- A future CSP must permit `blob:` for worklets.
- The vm harness stays source-based. It does not prove real audio-device behavior; the existing integration and packaged checks keep that boundary.
