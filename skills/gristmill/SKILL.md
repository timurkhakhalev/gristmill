---
name: gristmill
description: Read the user's recorded calls and meeting notes from Gristmill with the read-only `gristmill` CLI. Use when the user shares a call link such as `gristmill://notes/42` or `gristmill-dev://notes/42`, or asks about a past call, meeting, its Summary, transcript, participants, decisions, action items or quotes ("what did we agree on the call", "find the meeting where we discussed pricing", "summarize yesterday's sync").
allowed-tools: Bash(gristmill:*)
hidden: true
---

# gristmill

Read-only CLI for the calls that Gristmill recorded on the user's Mac:
Summary, user notes and the transcript with speakers and times.

Install: the Gristmill app installs `~/.local/bin/gristmill` (Settings → Advanced → Gristmill CLI).
Keep the app open while you use the CLI.

## Start here

This file is a discovery stub, not the usage guide. Before you run other
`gristmill` commands, load the guide from the CLI:

```bash
gristmill skills get core          # start here: call links, reading a call, search, rules
gristmill skills get core --full   # also the full command reference
```

The CLI prints the guide that matches the installed version, so the
instructions do not go stale. Run `gristmill skills list` to see all sections.

## Call links

A shared call link works wherever a Note ID goes, and it selects the app profile:

```bash
gristmill notes show gristmill://notes/42
gristmill notes transcript show gristmill-dev://notes/42
```
