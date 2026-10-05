# ArchiveBox records and artifacts

A capture contains the usual Webrecorder WARC/CDX/pages structure, plus two UTF-8 JSONL members:

| Member | Contents |
| --- | --- |
| `index.jsonl` | One ArchiveBox `Snapshot` and an `ArchiveResult` for each executed hook |
| `artifacts.jsonl` | Generated artifact identities, ownership, payload metadata, and storage references |

Both members appear in `datapackage.json.resources` with byte counts and SHA-256 hashes, and are covered by `datapackage-digest.json`. They are outside WACZ's reserved `archive/`, `indexes/`, and `pages/` directories, following the [WACZ extension rules](https://specs.webrecorder.net/wacz/1.1.1/#other-files-and-directories). Webrecorder owns WARC records, CDX indexes, revisit resolution, ZIP layout, and byte-range access.

The only ArchiveBox-specific datapackage field is the descriptor:

```json
{"archivebox":{"format":"archivebox","version":2,"index":"index.jsonl","artifacts":"artifacts.jsonl"}}
```

Capture status, configuration, hook diagnostics, and artifact locations are stored once in the JSONL members. The player projects these records into its runtime view model. Existing version-1 experimental captures are decoded at that same read boundary; new exports always use version 2.

## Snapshot and result records

The record names and common fields follow [abx-dl](https://github.com/ArchiveBox/abx-dl) and [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox). The portable definitions live in [`abx-plugins/shared/records.ts`](../abx-plugins/shared/records.ts), alongside the [index record JSON Schema](../abx-plugins/shared/index-record.schema.json). They have no Django, browser, or filesystem dependency.

- `Snapshot.id` is the original capture UUID. `ArchiveResult.id` is assigned when its hook starts and survives export/import. Local replay collection IDs are independent of these durable record IDs.
- `hook_name` follows Python's filename-stem convention, retaining the order and background suffix while removing `.ts`. The actual executed filename remains in `output_json.hook_filename`.
- `created_at`, `start_ts`, `end_ts`, and `ready_ts` are UTC ISO timestamps.
- Hook statuses are `succeeded`, `noresults`, `skipped`, and `failed`. A killed worker emits `failed` with `output_json.termination="killed"`. Unfinished hooks cannot be exported until shutdown/recovery records their outcome.
- A finished package has snapshot status `sealed`; `capture_state` preserves whether acquisition was complete, partial, or failed. Sealing does not imply every plugin succeeded.
- `config` contains the resolved flat named configuration. Hook-local `HOOK_TIMEOUT` overrides live in `plugin_config`. Sensitive keys use ArchiveBox's `********` redaction policy, including plugin `x-sensitive` declarations.
- `plugins` lists enabled plugins. Derived-only viewers do not acquire invented successful `ArchiveResult` rows.
- `output_json` preserves the plugin's small acquisition data, resource references, logs, and browser runtime diagnostics. It contains no copied response bodies.
- `output_files` is empty for WACZ-contained outputs: those are artifact references, not files in a native plugin output directory. A future Python importer can attach the WACZ container and resolve artifacts without pretending that every member already exists on disk.

The descriptor version identifies this interchange format independently of an ArchiveBox application's release version. The index is a capture manifest, not an append-only synchronization log. This change does not implement a Django database importer or automatically queue imported URLs for recapture.

## Shared artifact contract

[`artifact.schema.json`](../abx-plugins/shared/artifact.schema.json) describes `Artifact` records. Each has an `id`, `snapshot_id`, owning `plugin`, `kind`, creation timestamp, MIME type, logical payload `size`, SHA-256 `hash`, and exactly one storage reference:

| Storage type | Meaning |
| --- | --- |
| `file` | A real file relative to a native plugin output directory; defined for Python hosts, rejected inside a WACZ |
| `wacz-member` | A generated member such as `screenshot/screenshot.jpg` |
| `warc-response` | Generated content identical to an already stored original HTTP payload; references that exchange instead of storing another copy |

Original server responses are indexed by CDX and referenced directly by hook `output_json.records`; they are not copied into the artifact catalog. Each resource reference retains `{url, ts, captureId}` from the recorder, with optional `member` paths for content inside downloaded ZIPs. `ts` is Unix milliseconds and `captureId` is the owning snapshot UUID. The URL is the recorder's exact lookup key, including its POST request identity where applicable; it is not a new request to issue during replay.

Generated resource URNs resolve through `artifacts.jsonl`. Both generated artifacts and HTTP references use the existing `archive.read(ref)` API during capture; viewers use the shared archive reader. Plugins never handle offsets, CDX parsing, ZIP decompression, or revisit resolution.

Artifact sizes describe logical content. Multiple artifact identities may reference the same member or response. Storage totals count physical package members once, using the standard datapackage inventory; summing artifact sizes would double-count aliases. Generated files remain in their plugin folders, and original responses remain in WARC.

## Read with Python

This reads only the small metadata members; it does not extract the archive:

```python
import json
from zipfile import ZipFile
from abx_dl.models import Snapshot, ArchiveResult

with ZipFile("capture.wacz") as archive:
    descriptor = json.loads(archive.read("datapackage.json"))["archivebox"]
    for line in archive.read(descriptor["index"]).decode().splitlines():
        record = json.loads(line)
        model = Snapshot if record["type"] == "Snapshot" else ArchiveResult
        parsed = model.model_validate(record)
    artifacts = [json.loads(line) for line in archive.read(descriptor["artifacts"]).splitlines()]
```

The JSON Schema validation helper and live test also check IDs, hook outcomes, references, artifact payload hashes, and package hashes against a real all-plugin capture:

```sh
ABX_INTEROP_WACZ=/path/to/capture.wacz \
ABX_PYTHON_PROJECT=/path/to/abx-dl \
pnpm exec playwright test tests/interchange-live.test.ts
```

The test expects the normal capture harness's adjacent `capture.json`, so exported records can be compared with the actual acquisition outcomes. The Python validator uses `uv` and the installed abx-dl models, plus the shared JSON Schemas.

Datapackage resources declare Frictionless `type: "file"` so arbitrary plugin JSON is validated as a file, rather than inferred to be a pipeline or schema from its contents. Frictionless validation, member inventory/hash checks, the datapackage digest, and offline ReplayWeb.page reads are verified against the exported capture.

Webrecorder's Python `wacz 0.6.0 validate` has a path-check limitation: it takes the last two path components of every extracted file, so a root member such as `index.jsonl` becomes `<temporary-directory>/index.jsonl` and fails its inventory/hash lookup. The WACZ specification allows these root members. The tests check complete ZIP-relative paths and hashes directly; the upstream CLI does not currently report success for this layout.
