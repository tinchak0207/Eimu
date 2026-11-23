#!/usr/bin/env python3
"""Rebuild / verify the Eimu Blender local base asset library from manifest.json.

Standard library only (urllib, hashlib, zipfile, subprocess). No pip installs.

Usage
-----
    provision.py --verify          # hash-only check; never downloads
    provision.py                   # download/convert anything missing or corrupt
    provision.py --force           # re-download everything
    provision.py --root DIR ...    # operate on another library root
    provision.py --json            # machine-readable verify report

Root resolution order: --root > $BLENDER_WORK/assets > ~/Desktop/image-app/.blender-work/assets

Model entries are stored as self-contained .glb files. Rebuilding them needs
Blender on this host: $BLENDER_BIN, else `blender` on PATH, else
/home/lenovo/Applications/blender-5.2.1-linux-x64/blender.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) eimu-blender-asset-provisioner/1.0"
DEFAULT_BLENDER = "/home/lenovo/Applications/blender-5.2.1-linux-x64/blender"

GLTF_TO_GLB = """import bpy, sys
argv = sys.argv[sys.argv.index('--') + 1:]
src, dst = argv
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB')
"""


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def entry_hash(entry):
    """Entry-level hash: artifact hash, or set hash over sorted file hashes."""
    files = entry.get("files") or []
    if entry["kind"] == "texture_set" or len(files) > 1:
        lines = sorted(f"{f['sha256']}  {f['path']}" for f in files)
        return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()
    return files[0]["sha256"] if files else ""


def default_root():
    work = os.environ.get("BLENDER_WORK")
    if work:
        return os.path.join(work, "assets")
    return os.path.join(
        os.path.expanduser("~"), "Desktop", "image-app", ".blender-work", "assets"
    )


def download(url, dest, force=False):
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) > 0 and not force:
        return
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    os.replace(tmp, dest)


def blender_bin():
    candidates = [os.environ.get("BLENDER_BIN"), shutil.which("blender"), DEFAULT_BLENDER]
    for cand in candidates:
        if cand and os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    raise SystemExit(
        "Blender not found. Set BLENDER_BIN=/path/to/blender to rebuild model entries."
    )


def build_entry(entry, root, force=False):
    """Materialize one manifest entry. Returns True when files were written."""
    build = entry.get("build") or {}
    btype = build.get("type")
    wrote = False

    if btype == "direct":
        dest = os.path.join(root, build["output"])
        before = os.path.exists(dest) and not force
        download(build["url"], dest, force=force)
        wrote = not before

    elif btype == "direct_multi":
        for f in build["files"]:
            dest = os.path.join(root, f["path"])
            before = os.path.exists(dest) and not force
            download(f["url"], dest, force=force)
            wrote = wrote or not before

    elif btype == "zip_member":
        dest = os.path.join(root, build["output"])
        if force or not os.path.exists(dest):
            with tempfile.TemporaryDirectory() as td:
                zpath = os.path.join(td, "bundle.zip")
                download(build["url"], zpath, force=True)
                with zipfile.ZipFile(zpath) as zf:
                    member = build["member"]
                    if member not in zf.namelist():
                        raise SystemExit(
                            f"{entry['id']}: member {member!r} missing from {build['url']}"
                        )
                    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
                    with zf.open(member) as src, open(dest, "wb") as out:
                        shutil.copyfileobj(src, out)
            wrote = True

    elif btype == "gltf_to_glb":
        dest = os.path.join(root, build["output"])
        if force or not os.path.exists(dest):
            with tempfile.TemporaryDirectory() as td:
                gltf_path = os.path.join(td, os.path.basename(build["url"]))
                download(build["url"], gltf_path, force=True)
                for inc in build.get("include", []):
                    download(inc["url"], os.path.join(td, inc["path"]), force=True)
                conv = os.path.join(td, "_gltf_to_glb.py")
                with open(conv, "w") as f:
                    f.write(GLTF_TO_GLB)
                os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
                proc = subprocess.run(
                    [blender_bin(), "-b", "--factory-startup", "--python", conv, "--",
                     gltf_path, dest],
                    capture_output=True, text=True,
                )
                if proc.returncode != 0 or not os.path.exists(dest):
                    sys.stderr.write(proc.stdout[-2000:] + "\n" + proc.stderr[-2000:] + "\n")
                    raise SystemExit(f"{entry['id']}: glTF->GLB conversion failed")
            wrote = True

    else:
        raise SystemExit(f"{entry['id']}: unknown build type {btype!r}")

    return wrote


def verify_entry(entry, root):
    """Return (ok, lines) for one entry."""
    files = entry.get("files") or []
    if not files:
        return False, [f"FAIL {entry['id']}: manifest has no files[]"]

    ok = True
    lines = []
    total = 0
    for f in files:
        path = os.path.join(root, f["path"])
        if not os.path.isfile(path):
            ok = False
            lines.append(f"  MISSING {f['path']}")
            continue
        size = os.path.getsize(path)
        digest = sha256_file(path)
        total += size
        if size != f["bytes"]:
            ok = False
            lines.append(f"  BAD-SIZE {f['path']} expected={f['bytes']} actual={size}")
        if digest != f["sha256"]:
            ok = False
            lines.append(f"  BAD-SHA256 {f['path']} expected={f['sha256'][:12]} actual={digest[:12]}")

    if len(files) == 1:
        recorded = entry["sha256"]
        actual = files[0]["sha256"]
        if recorded != actual:
            ok = False
            lines.append(f"  BAD-ENTRY-HASH expected={recorded[:12]} actual={actual[:12]}")
    else:
        actual = entry_hash(entry)
        if actual != entry["sha256"]:
            ok = False
            lines.append(f"  BAD-ENTRY-HASH expected={entry['sha256'][:12]} actual={actual[:12]}")
    if total != entry["bytes"]:
        ok = False
        lines.append(f"  BAD-TOTAL-BYTES expected={entry['bytes']} actual={total}")

    status = "PASS" if ok else "FAIL"
    head = (f"{status} {entry['id']:<34s} {entry['kind']:<11s} "
            f"{len(files)} file(s) {entry['bytes']:>10d} B  {entry['sha256'][:12]}")
    return ok, [head] + lines


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description="Rebuild or verify the Eimu Blender base asset library.")
    ap.add_argument("--verify", action="store_true", help="hash-only check, never download")
    ap.add_argument("--force", action="store_true", help="re-download even when hashes match")
    ap.add_argument("--root", default=None, help="library root (default: $BLENDER_WORK/assets)")
    ap.add_argument("--manifest", default=None,
                    help="manifest path (default: <root>/manifest.json)")
    ap.add_argument("--json", action="store_true", help="print the verify report as JSON")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root or default_root())
    manifest_path = args.manifest or os.path.join(root, "manifest.json")
    if not os.path.isfile(manifest_path):
        # Bootstrap convenience: a manifest shipped next to this script wins over
        # a cold root, so a fresh host can be provisioned with one command.
        shipped = os.path.join(os.path.dirname(os.path.abspath(__file__)), "manifest.json")
        if args.manifest is None and os.path.isfile(shipped):
            manifest_path = shipped
        else:
            raise SystemExit(f"manifest not found: {manifest_path}")

    with open(manifest_path) as f:
        manifest = json.load(f)
    assets = manifest["assets"]

    if args.verify:
        results = []
        all_ok = True
        for entry in assets:
            ok, lines = verify_entry(entry, root)
            all_ok = all_ok and ok
            results.append({"id": entry["id"], "kind": entry["kind"], "ok": ok,
                            "detail": lines[1:]})
            if not args.json:
                print("\n".join(lines))
        files_total = sum(len(e.get("files") or []) for e in assets)
        bytes_total = sum(e["bytes"] for e in assets)
        if args.json:
            print(json.dumps({
                "root": root,
                "ok": all_ok,
                "entries": len(assets),
                "files": files_total,
                "bytes": bytes_total,
                "results": results,
            }, indent=2, ensure_ascii=False))
        else:
            print(f"\n{'OK' if all_ok else 'FAILED'}: "
                  f"{sum(1 for r in results if r['ok'])}/{len(assets)} entries, "
                  f"{files_total} files, {bytes_total / 1048576:.2f} MiB")
        return 0 if all_ok else 1

    # Rebuild mode: materialize everything, then verify.
    print(f"root: {root}")
    changed = 0
    for entry in assets:
        wrote = build_entry(entry, root, force=args.force)
        ok, _ = verify_entry(entry, root)
        if wrote:
            changed += 1
        print(f"{'built' if wrote else 'cached':<7s} {entry['id']} -> {entry['path']}"
              f"{'' if ok else '  ** HASH MISMATCH **'}")

    print("\nverify after rebuild:")
    all_ok = True
    for entry in assets:
        ok, lines = verify_entry(entry, root)
        all_ok = all_ok and ok
        print("\n".join(lines))

    files_total = sum(len(e.get("files") or []) for e in assets)
    bytes_total = sum(e["bytes"] for e in assets)
    print(f"\n{'OK' if all_ok else 'FAILED'}: {len(assets)} entries, "
          f"{files_total} files, {bytes_total / 1048576:.2f} MiB "
          f"({changed} entry build(s) touched)")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
