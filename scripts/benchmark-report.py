"""Summarize retained real capture runs without publishing HTTP logs or credentials."""
import argparse
import collections
import hashlib
import json
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("root", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()


def storage(root):
    seen = set()
    result = {"logical_bytes": 0, "allocated_bytes": 0, "files": 0, "symlinks": 0}
    for path in root.rglob("*") if root.is_dir() else [root]:
        if path.is_symlink():
            result["symlinks"] += 1
            continue
        if not path.is_file():
            continue
        stat = path.stat()
        key = (stat.st_dev, stat.st_ino)
        if key in seen:
            continue
        seen.add(key)
        result["files"] += 1
        result["logical_bytes"] += stat.st_size
        result["allocated_bytes"] += stat.st_blocks * 512
    return result


def network(path):
    log = json.loads(path.read_text())
    names = {v: k for k, v in log["constants"]["logEventTypes"].items()}
    counts = collections.Counter(names[e["type"]] for e in log["events"])
    headers = ["HTTP_TRANSACTION_SEND_REQUEST_HEADERS", "HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS", "HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS"]
    client = log["constants"].get("clientInfo", {})
    return {"browser": {k: client[k] for k in ["name", "version", "os_type"] if k in client},
            "browser_http_requests_sent": sum(counts[k] for k in headers), "by_protocol_event": {k: counts[k] for k in headers}}


report = {"date": "2026-10-04", "runs": {}}
for label in sorted(p.name for p in args.root.iterdir() if (p / "measurement/metrics.json").is_file()):
    root = args.root / label
    metrics = json.loads((root / "measurement/metrics.json").read_text())
    metrics = {k: v for k, v in metrics.items() if k not in {"command", "process_counters", "network_counters", "samples"}}
    run = {"metrics": metrics, "network": network(root / "netlog.json")}
    if "native" in label:
        snapshot, = (root / "collection/archive/users/system/snapshots").glob("*/*/*")
        rows = [json.loads(line) for line in (snapshot / "index.jsonl").read_text().splitlines()]
        # Snapshot journals contain both hook events and sealed result rows.
        # Count the final status once per hook, not once per journal entry.
        results = list({(r["plugin"], r["hook_name"]): r for r in rows if r.get("type") == "ArchiveResult"}.values())
        run.update({"snapshot_id": snapshot.name, "url": next(r["url"] for r in rows if r.get("type") == "Snapshot"), "storage": storage(snapshot),
                    "plugin_storage": {p.name: storage(p) for p in sorted(snapshot.iterdir()) if p.is_dir()},
                    "snapshot_version": next(r["schema_version"] for r in rows if r.get("type") == "Snapshot"),
                    "outcomes": [{"plugin": r["plugin"], "hook": r["hook_name"], "status": r["status"]} for r in results]})
        run["media"] = []
        for file in (snapshot / "ytdlp").glob("*.info.json"):
            info = json.loads(file.read_text())
            if info.get("format_id"):
                run["media"].append({k: info.get(k) for k in ["id", "title", "format_id", "duration", "acodec"]})
        run["media"].sort(key=lambda item: item["id"])
    else:
        archive = root / "capture.wacz"
        capture = json.loads((root / "capture.json").read_text())
        run.update({"url": capture["url"], "storage": storage(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                    "capture_state": capture["state"], "enabled_plugins": capture["plugins"],
                    "timing": json.loads((root / "timing.json").read_text()),
                    "outcomes": [{"plugin": h["plugin"], "hook": h["hook"], "status": h["status"], "summary": h.get("summary"), "elapsed_seconds": (h["ended"]-h["started"])/1000 if h.get("ended") and h.get("started") else None} for h in capture["hooks"]]})
        run["media"] = sorted(next(h["data"]["selectedFormats"] for h in capture["hooks"] if h["plugin"] == "ytdlp"), key=lambda item: item["id"])
        with zipfile.ZipFile(archive) as zipped:
            groups = collections.Counter()
            for member in zipped.infolist():
                groups[member.filename.split("/")[0]] += member.compress_size
            rows = [json.loads(line[line.index("{"):]) for line in zipped.read("indexes/index.cdx").decode().splitlines()]
            run["package_compressed_bytes"] = dict(groups)
            run["indexed_responses"] = len(rows)
            run["indexed_mime_counts"] = dict(collections.Counter(row.get("mime") for row in rows))
    report["runs"][label] = run
for extension in [label for label in report["runs"] if "extension" in label]:
    native = extension.replace("extension", "native")
    if native not in report["runs"]:
        continue
    n = {(m["id"], m["format_id"]) for m in report["runs"][native]["media"]}
    e = {(m["id"], m["format"]) for m in report["runs"][extension]["media"]}
    report["runs"][extension]["media_ids_and_formats_match_native"] = n == e
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2) + "\n")
for label, run in report["runs"].items():
    print(label, json.dumps({"metrics": run["metrics"], "storage": run["storage"], "network": run["network"], "outcomes": dict(collections.Counter(o["status"] for o in run["outcomes"]))}))
