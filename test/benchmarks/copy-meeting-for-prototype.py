"""Copy one note's audio and metadata for local experiments; never write the profile.
Usage: python3 test/benchmarks/copy-meeting-for-prototype.py PROFILE NOTE_ID NEW_DIR
Private files remain in NEW_DIR. Do not commit them.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import sys

profile = Path(sys.argv[1]).resolve()
note_id = int(sys.argv[2])
output = Path(sys.argv[3]).resolve()
repository = Path(__file__).resolve().parents[2]
if output.is_relative_to(repository):
    raise ValueError('Private copies must remain outside the repository')
output.mkdir(mode=0o700, parents=False, exist_ok=False)

def camel(name):
    parts = name.split('_')
    return parts[0] + ''.join(part.title() for part in parts[1:])

def dto(row):
    return {camel(key): row[key] for key in row.keys()}

connection = sqlite3.connect((profile / 'transcriptions.db').as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
try:
    connection.execute('BEGIN')
    recordings = connection.execute('SELECT * FROM meeting_recordings WHERE note_id=? ORDER BY started_at', (note_id,)).fetchall()
    if not recordings:
        raise ValueError('No recordings for note')
    result = []
    for recording in recordings:
        if recording['capture_state'] in ('recording', 'finalizing'):
            raise ValueError('Recording is still active')
        item = {'recording': dto(recording), 'epochs': []}
        for epoch in connection.execute('SELECT * FROM meeting_recording_epochs WHERE recording_id=? ORDER BY source,epoch_index', (recording['id'],)).fetchall():
            data = dto(epoch)
            data['alignmentSegments'] = [dto(row) for row in connection.execute('SELECT * FROM meeting_recording_epoch_alignments WHERE recording_id=? AND source=? AND epoch_index=? ORDER BY segment_index', (recording['id'], epoch['source'], epoch['epoch_index']))]
            source = (profile / 'audio/meetings' / recording['id'] / epoch['relative_path']).resolve()
            if not source.is_relative_to(profile / 'audio/meetings'):
                raise ValueError('Audio path escapes managed recordings')
            destination = output / (recording['id'] + '-' + epoch['source'] + '-' + str(epoch['epoch_index']) + '.opus')
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            shutil.copy2(source, destination)
            if before != hashlib.sha256(destination.read_bytes()).hexdigest() or before != hashlib.sha256(source.read_bytes()).hexdigest():
                raise ValueError('Source changed during copy')
            data['copyPath'] = str(destination)
            data['sha256'] = before
            item['epochs'].append(data)
        result.append(item)
    (output / 'input.json').write_text(json.dumps(result))
finally:
    connection.close()
print('Copied', len(result), 'recording parts; private output:', output)
