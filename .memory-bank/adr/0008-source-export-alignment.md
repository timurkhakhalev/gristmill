# ADR-0008: Source-scoped audio export alignment

Status: Accepted, 2026-10-04

## Context

Preparing a single-source export first validated alignment of both tracks. A
healthy source could not be exported when its peer had unresolved clock mapping.
Filtering the peer before computing duration would lose its proven later endpoint
and truncate trailing silence.

## Decision

Use a separate source-export preparation entrypoint in the existing mixer. Require
full proven alignment of the chosen source, then compute duration from the saved
common extent and all fully proven epoch endpoints. Unresolved peers supply no
fabricated offset or endpoint. Retain the historical UTC duration rule when no
saved frame extent exists. Reuse the same FFmpeg, WAV validation and atomic output.

## Consequences

A healthy source can be exported independently. Mixed playback, mixed export, ASR
and part composition still require alignment of every nonempty track. Any open
epoch blocks export. Empty sources still fail. The saved extent does not guarantee
an exact physical Stop boundary; capture and persistence are not changed.
