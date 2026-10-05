# ArchiveBox records in WACZ

`index.jsonl` contains one ArchiveBox `Snapshot` and an `ArchiveResult` for each executed hook. Generated outputs belong to their producing result's `output_files`; observations, diagnostics, and captured response references belong to `output_json`.

These use the existing [ArchiveBox](https://github.com/ArchiveBox/ArchiveBox) and [abx-dl models](https://github.com/ArchiveBox/abx-dl/blob/main/abx_dl/models.py). The browser's TypeScript declarations in [`abx-plugins/shared/records.ts`](../abx-plugins/shared/records.ts) mirror those fields. Python's existing `OutputFile` model preserves additional recorder metadata on each output entry.

## Snapshot and results

- `Snapshot.id` is the original capture UUID. Each `ArchiveResult.id` is assigned when its hook starts. Local replay collection IDs are independent of these record IDs.
- `hook_name` uses Python's filename-stem convention, retaining the order and background suffix while removing `.ts`. The executed filename remains in `output_json.hook_filename`.
- `created_at`, `start_ts`, `end_ts`, and `ready_ts` use UTC ISO timestamps.
- Hook outcomes are `succeeded`, `noresults`, `skipped`, or `failed`. Killed workers emit `failed` with `output_json.termination="killed"`.
- A finished package has snapshot status `sealed`; `capture_state` retains whether acquisition was complete, partial, or failed.
- `config` contains resolved named configuration with ArchiveBox's sensitive-value redaction. Hook-local `HOOK_TIMEOUT` settings remain in `plugin_config`.
- `plugins` lists enabled plugins. Derived-only viewers do not create capture results.

## Output files and response references

Each `ArchiveResult.output_files` entry uses the existing `path`, `extension`, `mimetype`, and `size` fields. `path` is the logical filename relative to that plugin's output directory, such as `screenshot.jpg` for the screenshot plugin.

Recorder metadata on the entry retains its resource `url`, millisecond timestamp `ts`, SHA-256 `hash`, `headers`, and `metadata`. The `storage` field locates its bytes:

| Storage | Location |
| --- | --- |
| `{"type":"wacz-member","path":"screenshot/screenshot.jpg"}` | A member relative to the WACZ root |
| `{"type":"warc-response","url":"https://…","ts":…}` | An existing HTTP payload with identical bytes |

The recorder associates generated output with the executing hook's result ID before saving it, including output written before a hook fails. Equal generated payloads share one member; output equal to a recorded HTTP body references that body. Output sizes describe logical content, while the datapackage inventory counts physical members once.

Original HTTP responses remain indexed by CDX. Hook `output_json.records` entries contain `{url, ts, captureId}` references, optionally with `member` paths inside a downloaded ZIP. The URL is the recorder's exact lookup key, including POST identity where applicable. Replay resolves these references without contacting the original server.

Plugins continue using `archive.fetch`, `archive.addResource`, and `archive.read`. The host assigns output ownership and resolves member paths, deduplication, byte ranges, and WARC revisits.

## Webrecorder packaging

The normal WARC/CDX/pages structure is unchanged. `index.jsonl` and generated plugin files pass through Webrecorder's exporter and appear in `datapackage.json.resources` with byte counts and SHA-256 hashes. `datapackage-digest.json` covers the manifest.

The optional datapackage field identifies the ArchiveBox index:

```json
{"archivebox":{"format":"archivebox","version":2,"index":"index.jsonl"}}
```

These extra members follow the [WACZ extension rules](https://specs.webrecorder.net/wacz/1.1.1/#other-files-and-directories), outside the reserved `archive/`, `indexes/`, and `pages/` directories. Webrecorder owns WARC/CDX writing and range-based replay. Standard WACZ files without ArchiveBox metadata remain readable.

Datapackage resources declare Frictionless `type: "file"` to avoid inferring pipeline definitions from arbitrary JSON content. Webrecorder's Python `wacz 0.6.0 validate` has a path-check limitation for root-level extra members: its lookup includes the extraction directory's name. The WACZ specification permits these members.

## Read with Python

Read the index without extracting response bodies:

```python
import json
from zipfile import ZipFile
from abx_dl.models import Snapshot, ArchiveResult

with ZipFile("capture.wacz") as archive:
    for line in archive.read("index.jsonl").decode().splitlines():
        record = json.loads(line)
        model = Snapshot if record["type"] == "Snapshot" else ArchiveResult
        parsed = model.model_validate(record)
```

This exposes capture records using the existing Python models; it does not import them into Django or implement database synchronization.
