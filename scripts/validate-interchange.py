"""Read exported JSONL with the existing abx-dl models."""
import json
import sys
from pathlib import Path

from abx_dl.models import ArchiveResult, Snapshot

data = json.loads(Path(sys.argv[1]).read_text())
for record in data["records"]:
    model = Snapshot if record["type"] == "Snapshot" else ArchiveResult
    parsed = model.model_validate(record)
    emitted = json.loads(parsed.to_jsonl())
    assert emitted["id"] == record["id"]
    if record["type"] == "ArchiveResult":
        assert emitted["output_json"] == record["output_json"]
        assert emitted["status"] == record["status"]
        assert emitted["hook_name"] == record["hook_name"]
        assert emitted["output_files"] == record["output_files"]
print(f"Validated {len(data['records'])} ArchiveBox records with Python abx-dl")
