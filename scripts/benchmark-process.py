"""Sample a real command's process tree on macOS; run with uv run python.

No privileged tracing is required. Counters are sampled lower bounds: short-lived
processes can exit between samples. RSS sums may count shared pages more than once.
Disk bytes are not IOPS, and nettop bytes are not HTTP request counts.
"""
import argparse
import ctypes
import json
import subprocess
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--network-interface", default="external", choices=["external", "all"])
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
command = args.command[1:] if args.command[0] == "--" else args.command
args.output.mkdir(parents=True, exist_ok=True)
fields = "user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size resident_size phys_footprint proc_start_abstime proc_exit_abstime child_user_time child_system_time child_pkg_idle_wkups child_interrupt_wkups child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten".split()


class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in fields]


lib = ctypes.CDLL("/usr/lib/libproc.dylib")
lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

timebase = Timebase()
ctypes.CDLL("/usr/lib/libSystem.dylib").mach_timebase_info(ctypes.byref(timebase))
seconds_per_tick = timebase.numer / timebase.denom / 1e9
start = time.monotonic()
started_at = time.time()
log = (args.output / "command.log").open("w")
child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
known = {child.pid}
maxima = {}
network = {}
samples = []
last_network = 0
while True:
    now = time.monotonic()
    processes = subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True)
    parents = {int(pid): int(ppid) for pid, ppid in (line.split() for line in processes.splitlines())}
    while True:
        discovered = {pid for pid, parent in parents.items() if parent in known}
        if discovered <= known:
            break
        known.update(discovered)
    rss = footprint = alive = 0
    for pid in known:
        usage = Usage()
        if lib.proc_pid_rusage(pid, 2, ctypes.byref(usage)) != 0:
            continue
        alive += 1
        rss += usage.resident_size
        footprint += usage.phys_footprint
        previous = maxima.setdefault(str(pid), {field: 0 for field in fields})
        for field in fields:
            previous[field] = max(previous[field], getattr(usage, field))
    if now - last_network >= 1:
        interface = [] if args.network_interface == "all" else ["-t", args.network_interface]
        net = subprocess.run(["nettop", "-P", "-L", "1", "-x", "-n", *interface, "-J", "bytes_in,bytes_out"], capture_output=True, text=True)
        for line in net.stdout.splitlines():
            values = line.split(",")
            try:
                pid = int(values[0].rsplit(".", 1)[1])
                if pid in known:
                    old = network.setdefault(str(pid), [0, 0])
                    old[0] = max(old[0], int(values[1]))
                    old[1] = max(old[1], int(values[2]))
            except (ValueError, IndexError):
                continue
        last_network = now
    samples.append({"seconds": now-start, "rss_bytes": rss, "footprint_bytes": footprint, "processes": alive, "cpu_seconds": sum(v["user_time"]+v["system_time"] for v in maxima.values()) * seconds_per_tick})
    if child.poll() is not None:
        break
    time.sleep(0.2)
elapsed = time.monotonic() - start
report = {"command": command, "started_at": started_at, "wall_seconds": elapsed, "exit_code": child.returncode,
          "mach_timebase": {"numer": timebase.numer, "denom": timebase.denom}, "network_interface": args.network_interface,
          "cpu_seconds_sampled": samples[-1]["cpu_seconds"], "peak_rss_bytes_sampled": max(v["rss_bytes"] for v in samples),
          "peak_footprint_bytes_sampled": max(v["footprint_bytes"] for v in samples), "process_count": len(maxima),
          "disk_read_bytes_sampled": sum(v["diskio_bytesread"] for v in maxima.values()),
          "disk_write_bytes_sampled": sum(v["diskio_byteswritten"] for v in maxima.values()),
          "network_in_bytes_sampled": sum(v[0] for v in network.values()), "network_out_bytes_sampled": sum(v[1] for v in network.values()),
          "iops": None, "samples": samples, "process_counters": maxima, "network_counters": network}
(args.output / "metrics.json").write_text(json.dumps(report, indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in {"samples", "process_counters", "network_counters"}}, indent=2))
raise SystemExit(child.returncode)
