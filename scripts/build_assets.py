#!/usr/bin/env python3
"""
Derives web-ready assets from Jess's master photography.

The masters (~2.1GB, single files up to 41MB) never enter the repo. This script
reads them from the source root, downsizes to MAX_EDGE and writes deterministic
filenames into src/assets/projects/<slug>/.

Why 2560px: Cloudflare Pages caps a single asset at 25 MiB and the free plan at
20,000 files per deployment. Astro emits ~5 srcset variants per image, so ~139
images is ~810 files — comfortably inside both. Feeding Astro a 2560px master
instead of a 41MB original is also what keeps the Pages build inside its
20-minute timeout.

Credit is carried across from the source filename where the photographer is
identifiable (see CREDIT_PATTERNS) and written into a sidecar manifest, so
per-image attribution survives the rename. Frontmatter can override it.

Python + Pillow rather than Node + sharp on purpose: sharp ships a
platform-specific native binary, so the pipeline breaks the moment it runs
somewhere other than the machine that installed it. Pillow does not have that
failure mode, and this script only ever runs on a developer's machine — the
derived files are committed, so Cloudflare never runs it.

Usage:
    python3 scripts/build_assets.py                 # only new/changed files
    python3 scripts/build_assets.py --force         # rebuild everything
    python3 scripts/build_assets.py --only enigma
    JESS_SOURCE=/path/to/masters python3 scripts/build_assets.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is required:  pip3 install --user Pillow")

MAX_EDGE = 2560
QUALITY = 80

DEFAULT_SOURCE = Path.home() / "Desktop/Jess/JESS PORTFOLIO IMAGES"
SOURCE_ROOT = Path(os.environ.get("JESS_SOURCE") or DEFAULT_SOURCE)
OUT_ROOT = Path.cwd() / "src/assets/projects"

# Source folder -> project slug. Add a line here when Jess adds a folder.
PROJECTS = [
    ("enigma", "ENIGMA PORTFOLIO"),
    ("medicine-field", "KUNDA PORTFOLIO"),
    ("senses-the-garden", "SENSES PORTFOLIO"),
    ("palapa", "PALAPA PORTFOLIO"),
    ("sandlantis", "SANDLANTIS PORTFOLIO"),
    ("nadia-editorial", "NADIA SHOOTS PORTFOLIO"),
    # Awaiting assets from Jess:
    # ("the-nest", "NEST PORTFOLIO"),
    # ("the-nest-lamps", "LAMPS PORTFOLIO"),
]

# Photographer inferred from the master filename. First match wins.
CREDIT_PATTERNS = [
    (re.compile(r"^DIARYOFROSS", re.I), "Diary of Ross"),
    (re.compile(r"^Doppe?[lg]gatz", re.I), "Christian Doppelgatz"),
    (re.compile(r"^Descandez", re.I), "Descandez"),
]

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
VIDEO_EXT = {".mov", ".mp4", ".m4v"}


def natural_key(name: str):
    """Stable, case-insensitive, digit-aware sort.

    Numbering depends on this order — anything that changes it silently
    reshuffles a gallery, so it is defined explicitly rather than left to the
    filesystem.
    """
    return [
        int(part) if part.isdigit() else part.lower()
        for part in re.split(r"(\d+)", name)
    ]


def credit_for(filename: str) -> str | None:
    for pattern, name in CREDIT_PATTERNS:
        if pattern.search(filename):
            return name
    return None


def process_project(slug: str, folder: str, force: bool) -> list[dict] | None:
    src_dir = SOURCE_ROOT / folder
    if not src_dir.is_dir():
        print(f"  ! skipped {slug} — no folder at {src_dir}", flush=True)
        return None

    out_dir = OUT_ROOT / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    # --force re-encodes every file in place rather than clearing the directory
    # first, so the script never needs delete permission. If a project's source
    # files are ever *removed*, stale outputs linger — they drop out of the
    # manifest, so the site ignores them, but tidy them by hand.

    entries = sorted(
        (e for e in os.listdir(src_dir) if not e.startswith(".")), key=natural_key
    )
    images = [e for e in entries if Path(e).suffix.lower() in IMAGE_EXT]
    videos = [e for e in entries if Path(e).suffix.lower() in VIDEO_EXT]

    if videos:
        print(f"  · {slug}: {len(videos)} video(s) left out of v1", flush=True)

    manifest: list[dict] = []
    written = 0

    for index, filename in enumerate(images, start=1):
        src_path = src_dir / filename
        out_name = f"{slug}-{index:02d}.jpg"
        out_path = out_dir / out_name

        needs_work = (
            force
            or not out_path.exists()
            or src_path.stat().st_mtime > out_path.stat().st_mtime
        )

        # A previous run that was interrupted mid-write leaves a truncated JPEG
        # behind. Reading its dimensions would raise and take this run down too,
        # so an unreadable existing file is treated as work to redo rather than
        # as a cache hit. It is overwritten rather than deleted — nothing in
        # this script unlinks, so it works unchanged on filesystems where
        # deletion is restricted.
        if not needs_work:
            try:
                with Image.open(out_path) as im:
                    im.verify()
            except Exception:
                print(f"  · {slug}: {out_name} was incomplete, rebuilding", flush=True)
                needs_work = True

        if needs_work:
            try:
                with Image.open(src_path) as im:
                    # draft() asks libjpeg to decode straight to a reduced scale
                    # rather than decompressing the full frame and shrinking it
                    # afterwards. On these masters (up to 41MB, ~8000px wide)
                    # that is the difference between ~150MB of RAM per image and
                    # ~10MB — without it the run gets OOM-killed part way
                    # through the larger folders.
                    im.draft("RGB", (MAX_EDGE, MAX_EDGE))
                    # Honour EXIF orientation before the metadata is dropped.
                    im = ImageOps.exif_transpose(im)
                    if im.mode not in ("RGB", "L"):
                        im = im.convert("RGB")
                    im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
                    im.save(
                        out_path,
                        "JPEG",
                        quality=QUALITY,
                        optimize=True,
                        progressive=True,
                    )
                    width, height = im.size
                written += 1
            except Exception as error:
                # One unreadable master must not take the whole run down. Leave
                # it out of the manifest so the gallery simply skips it, and say
                # so loudly enough to be fixed.
                print(f"  ! {slug}: could not process {filename} — {error}", flush=True)
                continue
        else:
            with Image.open(out_path) as im:
                width, height = im.size

        manifest.append(
            {
                "file": out_name,
                "source": filename,
                "width": width,
                "height": height,
                "orientation": "landscape" if width >= height else "portrait",
                "credit": credit_for(filename),
            }
        )

    (out_dir / "_manifest.json").write_text(
        json.dumps(manifest, indent="\t") + "\n", encoding="utf-8"
    )

    cached = len(manifest) - written
    print(f"  ✓ {slug}: {len(manifest)} images ({written} rebuilt, {cached} cached)", flush=True)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="rebuild every image")
    parser.add_argument("--only", metavar="SLUG", help="limit to one project")
    args = parser.parse_args()

    print(f"Deriving web assets from {SOURCE_ROOT}", flush=True)
    targets = [p for p in PROJECTS if not args.only or p[0] == args.only]
    if not targets:
        sys.exit(f"No project matching --only {args.only}")

    total = 0
    for slug, folder in targets:
        manifest = process_project(slug, folder, args.force)
        if manifest:
            total += len(manifest)

    print(f"\n{total} images ready. Astro will emit ~5 srcset variants each at build.")


if __name__ == "__main__":
    main()
