# Meeting resampler build and replacement

The package includes the exact unmodified FFmpeg source in `ffmpeg-8.1.1.tar.xz`,
the helper in `meeting-resampler.c`, the build recipe in
`build-meeting-resampler.cts`, and build-specific commands in `build.json`.
There are no source patches.

{{BUILD_DETAILS}}

Build on Apple Silicon with Xcode Command Line Tools (clang, SDK, make, tar,
curl and otool). `build.json` records the exact compiler identity, configure
flags, compiler command and tool invocations. Paths in that record describe the
original build directory; substitute your own extraction and install paths.
The build uses shared libswresample/libavutil only, arm64 and macOS 12.0, without
GPL, nonfree, version3, external libraries, protocols or OpenSSL.

In the Gristmill checkout run `pnpm run compile:native`. The pinned archive and
verified output cache live in `.cache/meeting-resampler-build/`. The cache key
includes checksum, configure flags, compiler identity, architecture, deployment
target and helper source hash. A complete verified cache works offline. Missing
source fails at build time. No runtime installation is required.

To rebuild outside the checkout, extract the archive, run the configure, make,
make install and clang commands from `build.json`, and keep the library install
names relative (`@loader_path/libavutil.60.dylib` and
`@loader_path/libswresample.6.dylib`). Place the resulting libraries beside the
helper in `Gristmill.app/Contents/Resources/bin/`. You may replace these LGPL
shared libraries with compatible modified versions. Keep their ABI/install names.
You may also relink the included helper source against your replacement libraries.

Replacing a signed binary changes the app signature. In your own copy, sign the
libraries and helper first with your identity (or `codesign --force --sign -` for
local use), then re-sign the app with its original hardened-runtime settings and
entitlements. Verify with `codesign --verify --deep --strict`. Ad-hoc signatures
are for local use; they do not provide Developer ID notarization or public trust.

## Private preparation interface

The helper reads mono float32 little-endian decoded at 48 kHz. Mapping input
coordinates and the `inputFrames` argument use the original 24 kHz recording
frame units; the decoded file must contain exactly two samples per input frame.
The timeline/output remains 24 kHz float32. The wrapper validates the final
24 kHz PCM16 WAV before publication.

At each run end the helper supplies 128 reflected input samples as normal filter
boundary context, after reading and validating the complete real input. This
context has 64 nominal output samples and is excluded from endpoint rounding and
published output. The remaining endpoint rounding bound is still two samples;
missing decoded input fails, and lost source audio is never replaced with silence.
