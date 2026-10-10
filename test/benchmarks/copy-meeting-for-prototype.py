"""Read-only raw-row/audio transport. Usage: PROFILE NOTE_ID NEW_DIRECTORY.
The user selects the note. Copies remain private and outside the checkout/profile.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys

profile = Path(sys.argv[1]).resolve(strict=True)
note_id = int(sys.argv[2])
output = Path(sys.argv[3]).resolve()
repository = Path(__file__).resolve().parents[2]
if output.is_relative_to(repository) or output.is_relative_to(profile):
    raise ValueError("Copies must remain outside repository and source profile")
database = profile / "transcriptions.db"
for file in [database, Path(str(database) + "-wal"), Path(str(database) + "-shm")]:
    if not file.is_file() or not os.access(file, os.R_OK):
        raise ValueError("Database and readable WAL sidecars are required; no immutable-mode bypass")


def digest(file):
    result = hashlib.sha256()
    with file.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            result.update(block)
    return result.hexdigest()


connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
try:
    connection.execute("PRAGMA query_only=ON")
    if connection.execute("PRAGMA journal_mode").fetchone()[0] != "wal":
        raise ValueError("A WAL database is required")
    connection.execute("BEGIN")
    recordings = [dict(row) for row in connection.execute(
        "SELECT * FROM meeting_recordings WHERE note_id=? ORDER BY started_at,id", (note_id,))]
    if not recordings:
        raise ValueError("No recordings for selected note")
    result = {"format": 1, "recordings": recordings, "epochs": [], "alignments": [], "intervals": [], "files": []}
    for recording in recordings:
        if recording["capture_state"] in ("recording", "finalizing") or recording["audio_state"] != "available":
            raise ValueError("Selected audio is active or unavailable")
        identity = recording["id"]
        result["epochs"].extend(dict(row) for row in connection.execute(
            "SELECT * FROM meeting_recording_epochs WHERE recording_id=? ORDER BY source,epoch_index", (identity,)))
        result["alignments"].extend(dict(row) for row in connection.execute(
            "SELECT * FROM meeting_recording_epoch_alignments WHERE recording_id=? ORDER BY source,epoch_index,segment_index", (identity,)))
        result["intervals"].extend(dict(row) for row in connection.execute(
            "SELECT * FROM meeting_recording_intentional_intervals WHERE recording_id=? ORDER BY created_at,id", (identity,)))
    # SQL scalars stay unchanged: TEXT nanoseconds and JSON are never DTO-mapped.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    copied = []
    for epoch in result["epochs"]:
        if epoch["state"] == "open":
            raise ValueError("Selected epoch is open")
        if epoch["frame_count"] == 0:
            continue
        source = (profile / "audio" / "meetings" / epoch["recording_id"] / epoch["relative_path"]).resolve(strict=True)
        if not source.is_relative_to(profile / "audio" / "meetings"):
            raise ValueError("Audio escapes managed storage")
        filename = f'{epoch["recording_id"]}-{epoch["source"]}-{epoch["epoch_index"]}.opus'
        destination = output / filename
        before = digest(source)
        shutil.copyfile(source, destination)
        destination.chmod(0o600)
        if before != digest(destination) or before != digest(source):
            raise ValueError("Source changed during copy")
        copied.append((source, before))
        result["files"].append({"recording_id": epoch["recording_id"], "source": epoch["source"], "epoch_index": epoch["epoch_index"], "file": filename, "sha256": before})
    for source, before in copied:
        if digest(source) != before:
            raise ValueError("Source changed/deleted before transport completed")
    # Failed transports never publish a manifest; private partial copies remain as evidence.
    manifest = output / "raw-rows.json"
    with manifest.open("x", encoding="utf8") as stream:
        json.dump(result, stream, ensure_ascii=False)
    manifest.chmod(0o600)
    connection.rollback()
finally:
    connection.close()
print("Selected fixture copied to the requested private directory; keep it outside Git and CI.")
