#!/usr/bin/env python3
"""Re-sign the 108 presigned Wasabi links in restate/videos.json.

Run under doppler so WASABI_* creds arrive via env:
    DOPPLER_TOKEN=... doppler run -p tiktok -c prd -- python3 resign_restate.py

Personal bucket gallery.hudeifahassan.com on s3.eu-central-2.wasabisys.com
(public access is disabled account-wide on Wasabi, so presigned GETs are
the only serving path; 7-day max expiry).
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VJ = os.path.join(REPO, "restate", "videos.json")
ENDPOINT = "s3.eu-central-2.wasabisys.com"
BUCKET = "gallery.hudeifahassan.com"

def find_creds():
    ak = sk = None
    ak_name = sk_name = None
    for name, val in os.environ.items():
        u = name.upper()
        if "WASABI" not in u or not val:
            continue
        if "SECRET" in u:
            sk, sk_name = val, name
        elif "ACCESS" in u or u.endswith("KEY_ID") or u.endswith("_KEY"):
            ak, ak_name = val, name
    if not (ak and sk):
        wasabi_names = [n for n in os.environ if "WASABI" in n.upper()]
        sys.exit(f"no Wasabi creds in env; WASABI-ish names present: {wasabi_names}")
    print(f"using creds from env vars: {ak_name} / {sk_name}")
    return ak, sk

def main():
    ak, sk = find_creds()
    env = dict(os.environ,
               RCLONE_S3_PROVIDER="Wasabi",
               RCLONE_S3_ENDPOINT=ENDPOINT,
               RCLONE_S3_ACCESS_KEY_ID=ak,
               RCLONE_S3_SECRET_ACCESS_KEY=sk)
    data = json.load(open(VJ))
    vids = data["videos"]
    assert len(vids) == 108, f"expected 108 entries, got {len(vids)}"
    for i, v in enumerate(vids):
        path = re.sub(r"\?.*", "", v["src"])
        m = re.match(rf"https://{ENDPOINT}/{re.escape(BUCKET)}/(.+)$", path)
        if not m:
            sys.exit(f"unexpected src shape: {path}")
        key = m.group(1)
        r = subprocess.run(
            ["rclone", "link", f":s3:{BUCKET}/{key}",
             "--expire", "168h", "--s3-no-check-bucket"],
            env=env, capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"rclone link failed for {key}: {r.stderr.strip()}")
        v["src"] = r.stdout.strip()
        if (i + 1) % 25 == 0:
            print(f"signed {i+1}/108")
    # spot-check: ranged GET on first and last new URL must return 206
    for probe in (vids[0]["src"], vids[-1]["src"]):
        req = urllib.request.Request(probe, headers={"Range": "bytes=0-64"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status not in (200, 206):
                sys.exit(f"probe failed: HTTP {resp.status}")
    print("spot-check: both probe URLs serve (206)")
    json.dump(data, open(VJ, "w"))
    print(f"wrote {VJ}")

if __name__ == "__main__":
    main()
