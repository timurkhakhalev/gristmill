# ADR-0004: Write the original tracks directly as Ogg/Opus

Status: Accepted
Date: 2026-09-30
Decided by: Timur; issue [#115](https://github.com/timurkhakhalev/gristmill/issues/115)

## Context

The original tracks were PCM files. Opus at 32 kbit/s is approximately 13 times smaller.
We needed a compact format without a separate compression step after Stop.
Recovery after a crash had to stay possible.

## Decision

- The microphone and the system audio are separate mono sources.
- 24 kHz PCM16LE exists only in capture memory.
- The bundled FFmpeg/libopus encodes it immediately to Ogg/Opus: 32 kbit/s VBR, `application=voip`, `compression_level=0`.
- There is no PCM file during capture and no compression step after Stop.
- The runtime uses only `.opus` files. There is no second codec path.
- Provider payload formats do not change. The derived WAV files come from the Opus files.

## Consequences

- 250 ms pages and one fsync each second are settings. They do not guarantee a maximum loss after a crash. A hardware check must measure the tail loss.
- Details: [audio storage](../architecture/audio-storage.md).
