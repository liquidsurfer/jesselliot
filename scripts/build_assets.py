#!/usr/bin/env python3
"""
Derives web-ready assets from Jess's master photography.

The masters (~2.1GB, single files up to 41MB) never enter the repo. This script
reads them from the source root, downsizes to MAX_EDGE and writes deterministic
filenames into src/assets/projects/<slug>/.

Why 2560px: Workers static assets cap a single file at 25 MiB, and a Worker
version at 20,000 files on the free plan (100,000 on paid). Astro emits ~5
srcset variants per image, so ~139 images is ~685 files — comfortably inside
both. Feeding Astro a 2560px master instead of a 41MB original is also what
keeps the build inside Workers Builds' 20-minute timeout.

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
import hashlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is required:  pip3 install --user Pillow")

MAX_EDGE = 2560
QUALITY = 80
# Hamming distance between two 64-bit difference hashes below which a pair is
# worth a human look. 0 is perceptually identical; genuinely different frames
# of the same subject measure high teens and up on this material.
NEAR_DUPLICATE = 8
# Edge deviation below which an image's border counts as uniform, and the
# minimum ring-to-centre difference that makes it a deliberate frame rather
# than a photograph that happens to have a plain sky along one side.
#
# Measured on this material: flat artwork and mounted work sit at 0.0-4.8,
# photographs at 37-87. A busy photograph with one quiet edge came in at 15.7,
# which is why the line is at 8 rather than splitting the difference.
EDGE_UNIFORM = 8
EDGE_CONTRAST = 24

DEFAULT_SOURCE = Path.home() / "Desktop/Jess changes 19 Sept/PORTFOLIO FINAL"
SOURCE_ROOT = Path(os.environ.get("JESS_SOURCE") or DEFAULT_SOURCE)
OUT_ROOT = Path.cwd() / "src/assets/projects"
# Polaroid clips are served verbatim — Astro's image pipeline does not touch
# video — so they land in public/ rather than src/assets/.
VIDEO_OUT = Path.cwd() / "public/polaroids"

# Source folder -> project slug. Add a line here when Jess adds a folder.
#
# Folder names are Jess's, verbatim, including the trailing space in "PALAPA ".
# Correcting them here rather than renaming her folders means a re-download of
# the drive does not silently stop matching.
PROJECTS = [
    ("enigma", "ENIGMA"),
    ("medicine-field", "MEDICINE FIELD"),
    ("senses-the-garden", "SENSES - THE GARDEN"),
    ("the-nest", "THE NEST"),
    ("the-nest-lamps", "THE NEST/NEST LAMP"),
    ("palapa", "PALAPA "),
    ("sandlantis", "SANDLANTIS"),
    ("brick-painting", "BRICK PAINTING"),
    ("house-of-david", "HOUSE OF DAVID"),
    ("die-suurlemoen-padstal", "DIE SUURLEMOEN PADSTAL"),
    ("dragon-world", "DRAGON WORLD"),
    ("artist-residency", "ARTIST RESIDENCY"),
    ("nadia-editorial", "NADIA VON SCOTTI"),
    ("sound-bowl", "PASSAGES PRESENTS - SOUND BOWL"),
    ("london-calling", "LONDON CALLING"),
    ("human", "HUMAN BBC"),
    ("illumina", "ILLUMINA EXHIBITION"),
]

# Projects whose source folder is split into sections that must stay grouped
# and ordered on the page. Numbering runs continuously across the sections;
# the section slug rides along in the manifest so the page can break on it.
SECTIONS = {
    "nadia-editorial": [
        ("womanhood", "WOMANHOOD"),
        ("still-life", "STILL"),
        ("orion", "ORION"),
    ],
}

# Galleries that are not projects. Same pipeline, different output root.
GALLERIES = [
    ("identity-and-branding", "GRAPHIC DESIGN/IDENTITY + BRANDING ", "src/assets/graphics"),
    ("print-and-communication", "GRAPHIC DESIGN/PRINT + COMMUNICATION", "src/assets/graphics"),
    ("printmaking-and-applied-art", "GRAPHIC DESIGN/PRINTMAKING + APPLIED ART", "src/assets/graphics"),
    ("about", "ABOUT THE ARTIST", "src/assets"),
]

# Photographer inferred from the master filename. First match wins.
CREDIT_PATTERNS = [
    (re.compile(r"^DIARYOFROSS", re.I), "Diary of Ross"),
    (re.compile(r"^Doppe?[lg]gatz", re.I), "Christian Doppelgatz"),
    (re.compile(r"^Descandez", re.I), "Descandez"),
]

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp"}
VIDEO_EXT = {".mov", ".mp4", ".m4v"}

# Jess labels the images that carry a specific job on the page. The labelling
# is consistent in intent but not in spelling — "HERO 1", "HERO1", "HERO IMAGE
# 3", "HERO - HUMAN_0031", and Senses reverses "TOP LANDSCAPE" to "LANDSCAPE
# TOP" — so these are deliberately loose. The role goes into the manifest and
# gallery.ts derives `landing` and `cover` from it, which is what saves hand-
# writing fifty filenames into frontmatter.
#
#   hero           the homepage tile rotates through these
#   top-landscape  the projects-index row image, and the project page's top
#   signs          Enigma's horizontally scrolling band
ROLE_PATTERNS = [
    ("top-landscape", re.compile(r"TOP\s*LANDSCAPE|LANDSCAPE\s*TOP", re.I)),
    ("signs", re.compile(r"SIGNS\s*SCROLL", re.I)),
    ("hero", re.compile(r"^HERO", re.I)),
]

# Only clips Jess labelled POLAROID are the process-shots that sit beside a
# project title. Nadia's folders also carry raw shoot footage (IMG_*.MOV and a
# UUID .mp4) which is not that, and is left alone.
POLAROID = re.compile(r"POLAROID", re.I)


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


def source_digest(path: Path) -> str:
    """md5 of the master's bytes, for exact-duplicate detection."""
    h = hashlib.md5()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dhash(path: Path, size: int = 8) -> int | None:
    """
    A difference hash of the derived image — a cheap perceptual fingerprint.

    Compares each pixel with its right-hand neighbour in a tiny greyscale
    version, so two photographs of the same thing land close together even if
    the exposure or crop differs slightly. Only used to *warn*: two frames of
    one shot may well both be wanted.
    """
    try:
        with Image.open(path) as im:
            small = im.convert("L").resize((size + 1, size), Image.LANCZOS)
            # tobytes() rather than getdata(): same row-major greyscale values,
            # and getdata() is deprecated as of Pillow 12.
            px = small.tobytes()
    except Exception:
        return None
    bits = 0
    for row in range(size):
        base = row * (size + 1)
        for col in range(size):
            bits = bits << 1 | (px[base + col] > px[base + col + 1])
    return bits


def analyse(path: Path) -> tuple[str, float, float] | None:
    """
    Two facts about a derived image that the layout needs: whether it survives
    being cropped, and how light it is.

    Crop safety is read from the edges. A photograph has busy, varied edges; a
    poster, a flat artwork or anything with a drawn border has a near-uniform
    ring around it, and slicing that ring to fill a box ruins the piece. On
    this material the two separate cleanly — photographs measure 30-90 on the
    edge deviation, flat and framed work 1.5-14 — so the threshold sits well
    clear of both. It errs towards "safe": a misread there crops a photograph
    slightly, where the opposite cuts the border off a print.

    It is a heuristic and it knows it. A heavily vignetted photograph — a dark
    subject in a dark doorway — has a genuinely uniform edge and will be
    flagged. That costs nothing, because the flag only changes behaviour where
    an image is cropped to fill a fixed box; everywhere else images render at
    their own proportions and it is ignored.

    Luminance is the mean of the whole frame, used to break gallery rows so
    two dark photographs do not land side by side. Top luminance is the mean
    of the upper strip only — where a project page floats its nav over the
    hero, that band decides whether the links are set dark or light. Across
    these projects it ranges from 13/255 (Sandlantis, near black) to 193
    (Palapa), so one fixed treatment cannot serve both.
    """
    try:
        with Image.open(path) as im:
            small = im.convert("L")
            small.thumbnail((240, 240))
    except Exception:
        return None

    w, h = small.size
    px = small.load()
    band_w, band_h = max(2, int(w * 0.035)), max(2, int(h * 0.035))

    ring, centre = [], []
    for y in range(h):
        edge_row = y < band_h or y >= h - band_h
        for x in range(w):
            value = px[x, y]
            if edge_row or x < band_w or x >= w - band_w:
                ring.append(value)
            else:
                centre.append(value)

    if not ring or not centre:
        return None

    strip_rows = max(1, int(h * 0.18))
    strip = [px[x, y] for y in range(strip_rows) for x in range(w)]
    top_luminance = sum(strip) / len(strip) / 255

    ring_mean = sum(ring) / len(ring)
    centre_mean = sum(centre) / len(centre)
    deviation = (sum((v - ring_mean) ** 2 for v in ring) / len(ring)) ** 0.5

    protect = deviation < EDGE_UNIFORM and abs(ring_mean - centre_mean) > EDGE_CONTRAST
    luminance = (sum(ring) + sum(centre)) / (len(ring) + len(centre)) / 255
    return (
        "protect" if protect else "safe",
        round(luminance, 3),
        round(top_luminance, 3),
    )


def role_for(filename: str) -> str | None:
    """Which job, if any, Jess's filename assigns this image."""
    stem = Path(filename).stem
    for role, pattern in ROLE_PATTERNS:
        if pattern.search(stem):
            return role
    return None


def process_project(
    slug: str,
    folder: str,
    force: bool,
    out_root: Path | None = None,
    sections: list[tuple[str, str]] | None = None,
) -> list[dict] | None:
    src_dir = SOURCE_ROOT / folder
    if not src_dir.is_dir():
        print(f"  ! skipped {slug} — no folder at {src_dir}", flush=True)
        return None

    out_dir = (out_root or OUT_ROOT) / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    # --force re-encodes every file in place rather than clearing the directory
    # first, so the script never needs delete permission. If a project's source
    # files are ever *removed*, stale outputs linger — they drop out of the
    # manifest, so the site ignores them, but tidy them by hand.

    def listing(directory: Path) -> list[str]:
        return sorted(
            (e for e in os.listdir(directory) if not e.startswith(".")),
            key=natural_key,
        )

    # (section slug or None, directory, filename). A sectioned project keeps
    # its sections in the order SECTIONS declares, not alphabetically, because
    # that order is editorial — Jess's document runs Womanhood, Still, Orion.
    picks: list[tuple[str | None, Path, str]] = []
    if sections:
        for section_slug, sub_folder in sections:
            sub_dir = src_dir / sub_folder
            if not sub_dir.is_dir():
                print(f"  ! {slug}: no section folder {sub_folder}", flush=True)
                continue
            for name in listing(sub_dir):
                if Path(name).suffix.lower() in IMAGE_EXT:
                    picks.append((section_slug, sub_dir, name))
    else:
        for name in listing(src_dir):
            if Path(name).suffix.lower() in IMAGE_EXT:
                picks.append((None, src_dir, name))

    manifest: list[dict] = []
    written = 0
    # Byte-identical masters, keyed by md5. Jess's drive carries a few — a
    # "HERO2 copy.jpg" sitting beside "HERO2.jpg" is the same file twice, and
    # shipping both puts the same photograph next to itself in a gallery and
    # weights it double in the homepage rotation. Exact match only: a
    # perceptual near-match might be two frames she wants.
    # Resolved in a pre-pass so the file that survives is the canonically named
    # one. Plain alphabetical order would keep "HERO2 copy.jpg" and drop
    # "HERO2.jpg", which is the wrong way round for provenance — the manifest
    # records the source filename, and credit_for() reads it.
    duplicates: dict[str, str] = {}
    by_digest: dict[str, list[tuple[Path, str]]] = {}
    for _, pick_dir, filename in picks:
        by_digest.setdefault(source_digest(pick_dir / filename), []).append(
            (pick_dir, filename)
        )
    for group in by_digest.values():
        if len(group) < 2:
            continue
        # A " copy" suffix loses; after that, the shorter name wins.
        keep = min(group, key=lambda g: ("copy" in g[1].lower(), len(g[1]), g[1]))
        for pick_dir, filename in group:
            if (pick_dir, filename) != keep:
                duplicates[str(pick_dir / filename)] = keep[1]

    index = 0

    for section, pick_dir, filename in picks:
        src_path = pick_dir / filename

        twin = duplicates.get(str(src_path))
        if twin:
            print(f"  · {slug}: {filename} is byte-identical to {twin}, skipped",
                  flush=True)
            continue

        index += 1
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

        entry = {
            "file": out_name,
            "source": filename,
            "width": width,
            "height": height,
            "orientation": "landscape" if width >= height else "portrait",
            "credit": credit_for(filename),
        }
        measured = analyse(out_path)
        if measured:
            entry["crop"], entry["luminance"], entry["topLuminance"] = measured
        role = role_for(filename)
        if role:
            entry["role"] = role
        if section:
            entry["section"] = section
        manifest.append(entry)

    (out_dir / "_manifest.json").write_text(
        json.dumps(manifest, indent="\t") + "\n", encoding="utf-8"
    )

    cached = len(manifest) - written
    print(f"  ✓ {slug}: {len(manifest)} images ({written} rebuilt, {cached} cached)", flush=True)

    # Near-duplicates are reported, never dropped. Two frames of one shot can
    # be deliberate; two frames of one shot sitting side by side in a collage
    # usually is not, so the pair is named and left to Jess.
    fingerprints = [(entry["file"], dhash(out_dir / entry["file"])) for entry in manifest]
    for i, (file_a, hash_a) in enumerate(fingerprints):
        if hash_a is None:
            continue
        for file_b, hash_b in fingerprints[i + 1:]:
            if hash_b is None:
                continue
            distance = bin(hash_a ^ hash_b).count("1")
            if distance <= NEAR_DUPLICATE:
                print(f"  ? {slug}: {file_a} and {file_b} look nearly identical "
                      f"(distance {distance}) — check the order", flush=True)

    return manifest


def probe(path: Path) -> tuple[int, int] | None:
    """Source dimensions via ffprobe, or None if it cannot be read."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x",
             str(path)],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        w, h = out.split("x")[:2]
        return int(w), int(h)
    except Exception:
        return None


def process_videos(slug: str, folder: str, force: bool) -> list[dict]:
    """Derive the polaroid clips that sit beside a project title.

    The masters are ~11MB each — 10-14s of portrait iPhone HEVC in a QuickTime
    container, which Safari plays and Chrome often does not. Each becomes a
    muted h264 mp4 capped at 640px plus a poster frame.

    h264 only, no webm: VP9 was measured at roughly twice the size of h264 on
    this footage (2.9MB against 1.3MB for the same clip), and baseline h264 in
    an mp4 already plays in every browser that matters. A second encode that is
    bigger than the one it was meant to undercut is just bytes.

    Output goes to public/, not src/assets/, because Astro's image pipeline
    does not process video and would leave them unhashed anyway.
    """
    src_dir = SOURCE_ROOT / folder
    if not src_dir.is_dir():
        return []

    clips = [
        e for e in sorted(os.listdir(src_dir), key=natural_key)
        if not e.startswith(".")
        and Path(e).suffix.lower() in VIDEO_EXT
        and POLAROID.search(e)
    ]
    if not clips:
        return []

    if not shutil.which("ffmpeg"):
        print(f"  ! {slug}: {len(clips)} clip(s) skipped — ffmpeg not installed", flush=True)
        return []

    VIDEO_OUT.mkdir(parents=True, exist_ok=True)
    # 640 on the long edge. These render at roughly 220px wide beside a project
    # title, so this is already generous on a 2x display.
    scale = "scale=w=640:h=640:force_original_aspect_ratio=decrease:force_divisible_by=2"
    videos: list[dict] = []

    for index, filename in enumerate(clips, start=1):
        src_path = src_dir / filename
        stem = f"{slug}-polaroid-{index:02d}"
        mp4 = VIDEO_OUT / f"{stem}.mp4"
        poster = VIDEO_OUT / f"{stem}.jpg"

        stale = force or not all(f.exists() for f in (mp4, poster))
        if not stale:
            stale = src_path.stat().st_mtime > mp4.stat().st_mtime

        if stale:
            jobs = [
                (["-an", "-vf", scale, "-c:v", "libx264", "-crf", "32",
                  "-preset", "slow", "-pix_fmt", "yuv420p",
                  "-movflags", "+faststart"], mp4),
                (["-vf", scale, "-frames:v", "1", "-q:v", "4"], poster),
            ]
            failed = False
            for extra, out_path in jobs:
                result = subprocess.run(
                    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src_path),
                     *extra, str(out_path)],
                    capture_output=True, text=True,
                )
                if result.returncode != 0:
                    print(f"  ! {slug}: {filename} -> {out_path.name} failed — "
                          f"{result.stderr.strip()[:160]}", flush=True)
                    failed = True
                    break
            if failed:
                continue

        size = probe(mp4) or (0, 0)
        videos.append({
            "id": stem,
            "source": filename,
            "mp4": f"/polaroids/{stem}.mp4",
            "poster": f"/polaroids/{stem}.jpg",
            "width": size[0],
            "height": size[1],
            "orientation": "landscape" if size[0] >= size[1] else "portrait",
        })

    weight = sum((VIDEO_OUT / f"{v['id']}.mp4").stat().st_size for v in videos)
    print(f"  ▸ {slug}: {len(videos)} polaroid clip(s), {weight / 1024:.0f}KB", flush=True)
    return videos


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="rebuild every image")
    parser.add_argument("--only", metavar="SLUG", help="limit to one project")
    args = parser.parse_args()

    print(f"Deriving web assets from {SOURCE_ROOT}", flush=True)
    targets = [p for p in PROJECTS if not args.only or p[0] == args.only]
    galleries = [g for g in GALLERIES if not args.only or g[0] == args.only]
    if not targets and not galleries:
        sys.exit(f"No project matching --only {args.only}")

    total = 0
    clips = 0
    for slug, folder in targets:
        manifest = process_project(
            slug, folder, args.force, sections=SECTIONS.get(slug)
        )
        if manifest:
            total += len(manifest)
        videos = process_videos(slug, folder, args.force)
        if videos:
            clips += len(videos)
            (OUT_ROOT / slug / "_videos.json").write_text(
                json.dumps(videos, indent="\t") + "\n", encoding="utf-8"
            )

    for slug, folder, root in galleries:
        manifest = process_project(slug, folder, args.force, out_root=Path.cwd() / root)
        if manifest:
            total += len(manifest)

    print(f"\n{total} images and {clips} clips ready. "
          f"Astro will emit ~5 srcset variants per image at build.")


if __name__ == "__main__":
    main()
