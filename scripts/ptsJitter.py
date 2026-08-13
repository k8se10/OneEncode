"""
Ground-truth frame-pacing jitter, computed from real frame PTS values
extracted from a recorded output file — independent of and more precise
than the -stats-based CoV metric (src/legs/statsAnalysis.ts), which only
samples periodically. Used to cross-check that metric during the
rendition-dedup jitter regression investigation (task #24, see
PATCHNOTES.md and CLAUDE.md §8 for the full writeup and real numbers).

Usage:
    ffprobe -v error -select_streams v:0 -show_entries frame=pts_time \
        -of csv=p=0 recordings/some_output.mp4 > pts.txt
    python scripts/ptsJitter.py pts.txt

Real result confirmed 2026-08-13: a baseline (naive, one process per
destination) recording showed CoV=0.0000 (essentially perfectly uniform
frame delivery); the rendition-dedup design's recording showed CoV=0.074
(frame deltas swinging ~10% around the 60fps target) for the same
synthetic source and duration — a starker, more precise confirmation of
the jitter regression than the -stats-based metric alone showed.
"""

import sys
import statistics

path = sys.argv[1]
with open(path) as f:
    # ffprobe's csv=p=0 output occasionally has a trailing comma or an N/A
    # field (e.g. a frame missing pts_time) -- take the first field and
    # skip anything that isn't a real number rather than failing outright.
    pts = []
    for line in f:
        field = line.strip().split(",")[0]
        if not field or field == "N/A":
            continue
        pts.append(float(field))

deltas = [pts[i + 1] - pts[i] for i in range(len(pts) - 1)]
mean = statistics.mean(deltas)
stdev = statistics.pstdev(deltas)
cov = stdev / mean if mean else 0
print(
    f"frames={len(pts)} deltas={len(deltas)} mean_delta={mean:.6f} "
    f"stdev_delta={stdev:.6f} CoV={cov:.4f} min={min(deltas):.6f} max={max(deltas):.6f}"
)
