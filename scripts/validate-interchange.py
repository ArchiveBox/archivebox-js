"""Validate real exported JSONL with the shared schemas and installed abx-dl."""
import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator, FormatChecker
from abx_dl.models import ArchiveResult, Snapshot
from abx_dl.output_files import OutputManifest

data = json.loads(Path(sys.argv[1]).read_text())
schemas = Path(__file__).resolve().parents[1] / "abx-plugins/shared"
index_validator = Draft7Validator(json.loads((schemas / "index-record.schema.json").read_text()), format_checker=FormatChecker())
artifact_validator = Draft7Validator(json.loads((schemas / "artifact.schema.json").read_text()), format_checker=FormatChecker())
for record in data["records"]:
    index_validator.validate(record)
    model = Snapshot if record["type"] == "Snapshot" else ArchiveResult
    parsed = model.model_validate(record)
    emitted = json.loads(parsed.to_jsonl())
    assert emitted["id"] == record["id"]
    if record["type"] == "ArchiveResult":
        assert emitted["output_json"] == record["output_json"]
        assert emitted["status"] == record["status"]
        assert emitted["hook_name"] == record["hook_name"]
        assert OutputManifest.from_value(emitted["output_files"]).total_size == 0
for artifact in data["artifacts"]:
    artifact_validator.validate(artifact)
print(f"Validated {len(data['records'])} ArchiveBox records and {len(data['artifacts'])} artifacts with Python abx-dl and JSON Schema")
