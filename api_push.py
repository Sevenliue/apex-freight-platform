#!/usr/bin/env python3
"""Push local file changes to the ShipRate GitHub repo via the GitHub API.

Usage: api_push.py OWNER REPO <file1> [file2 ...]
Files are paths relative to the repo root (cwd). Builds the new tree on top
of the current remote HEAD tree, so remote-only changes are never clobbered.
"""
import base64
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_response_body

BASE = "https://api.github.com"
ALLOWED = ["api.github.com"]
CRED = "custom.github"


def call(method, path, payload=None):
    req = urllib.request.Request(BASE + path, method=method)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode()
        req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/vnd.github+json")
    add_surrogate_to_request(req, CRED, allowed_hosts=ALLOWED)
    try:
        with urllib.request.urlopen(req, data=data, timeout=120) as resp:
            body = read_response_body(resp)
            return resp.status, json.loads(body.decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:2000]


def main():
    owner, repo, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    s, ref = call("GET", f"/repos/{owner}/{repo}/git/refs/heads/main")
    assert s == 200, ref
    head = ref["object"]["sha"]
    s, commit = call("GET", f"/repos/{owner}/{repo}/git/commits/{head}")
    assert s == 200, commit
    base_tree = commit["tree"]["sha"]

    tree_entries = []
    for f in files:
        with open(f, "rb") as fh:
            content = base64.b64encode(fh.read()).decode()
        s, blob = call("POST", f"/repos/{owner}/{repo}/git/blobs",
                       {"content": content, "encoding": "base64"})
        assert s == 201, blob
        tree_entries.append({"path": f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("blob", f, blob["sha"][:12])

    s, tree = call("POST", f"/repos/{owner}/{repo}/git/trees",
                   {"base_tree": base_tree, "tree": tree_entries})
    assert s == 201, tree
    msg = os.environ.get("COMMIT_MSG") or "Auto-save shipment addresses to customer address book"
    s, new_commit = call("POST", f"/repos/{owner}/{repo}/git/commits",
                         {"message": msg, "tree": tree["sha"], "parents": [head]})
    assert s == 201, new_commit
    s, updated = call("PATCH", f"/repos/{owner}/{repo}/git/refs/heads/main",
                      {"sha": new_commit["sha"]})
    assert s == 200, updated
    print("pushed commit", new_commit["sha"])


if __name__ == "__main__":
    main()
