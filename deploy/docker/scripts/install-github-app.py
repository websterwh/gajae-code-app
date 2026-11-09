#!/usr/bin/env python3
import sys
import os
import json
import urllib.request
import zipfile
import stat

def install_github_app(repo, target_bin="/data/bin", target_share="/data/share"):
    repo = repo.strip()
    if not repo:
        return
    headers = {"User-Agent": "GitHub-App-Installer"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    api_url = f"https://api.github.com/repos/{repo}/releases/latest"
    try:
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"==> [WARN] Could not fetch release info for {repo}: {e}")
        return

    tag = data.get("tag_name", "latest")
    assets = data.get("assets", [])

    os.makedirs(target_bin, exist_ok=True)
    os.makedirs(target_share, exist_ok=True)

    repo_lower = repo.lower()
    # Special handler: jadx
    if "jadx" in repo_lower:
        dest_dir = os.path.join(target_share, f"jadx-{tag}")
        link_path = os.path.join(target_bin, "jadx")
        if os.path.exists(os.path.join(dest_dir, "bin", "jadx")) and (os.path.exists(link_path) or os.path.islink(link_path)):
            print(f"==> [GitHub App] jadx {tag} is already installed.")
            return

        print(f"==> [GitHub App] Installing {repo}...")
        asset = next((a for a in assets if a["name"].endswith(".zip") and "win" not in a["name"]), None)
        if asset:
            zip_tmp = f"/tmp/jadx-{tag}.zip"
            print(f"==> [GitHub App] Downloading {asset['name']} ({tag})...")
            urllib.request.urlretrieve(asset["browser_download_url"], zip_tmp)
            with zipfile.ZipFile(zip_tmp, 'r') as zip_ref:
                zip_ref.extractall(dest_dir)
            if os.path.exists(zip_tmp):
                os.remove(zip_tmp)
            jadx_bin = os.path.join(dest_dir, "bin", "jadx")
            if os.path.exists(jadx_bin):
                os.chmod(jadx_bin, os.stat(jadx_bin).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
                if os.path.islink(link_path) or os.path.exists(link_path):
                    os.remove(link_path)
                os.symlink(jadx_bin, link_path)
                print(f"==> [GitHub App] Successfully installed jadx -> {link_path}")
            return

    # Special handler: apktool
    if "apktool" in repo_lower:
        jar_dest = os.path.join(target_share, f"apktool-{tag}.jar")
        wrapper_path = os.path.join(target_bin, "apktool")
        if os.path.exists(jar_dest) and os.path.exists(wrapper_path):
            print(f"==> [GitHub App] apktool {tag} is already installed.")
            return

        print(f"==> [GitHub App] Installing {repo}...")
        asset = next((a for a in assets if a["name"].endswith(".jar")), None)
        if asset:
            print(f"==> [GitHub App] Downloading {asset['name']} ({tag})...")
            urllib.request.urlretrieve(asset["browser_download_url"], jar_dest)
            with open(wrapper_path, "w") as f:
                f.write(f'#!/bin/sh\nexec java -Xmx1024M -Dfile.encoding=UTF-8 -jar "{jar_dest}" "$@"\n')
            os.chmod(wrapper_path, 0o755)
            print(f"==> [GitHub App] Successfully installed apktool wrapper -> {wrapper_path}")
            return

    # Fallback to aqua if it's a standard aqua package
    import subprocess
    pkg_entry = f"{repo}@{tag}" if "@" not in repo else repo
    print(f"==> [Aqua] Attempting aqua install for {pkg_entry}...")
    yaml_path = "/data/aqua/aqua.yaml"
    with open(yaml_path, "w") as f:
        f.write(f"---\nregistries:\n  - type: standard\n    ref: v4.325.0\npackages:\n  - name: {pkg_entry}\n")
    res = subprocess.run(["aqua", "install", "-l", "-a", "-c", yaml_path], env=dict(os.environ, AQUA_ROOT_DIR="/data/aqua"))
    if res.returncode == 0:
        aqua_bin_dir = "/data/aqua/bin"
        if os.path.exists(aqua_bin_dir):
            for b in os.listdir(aqua_bin_dir):
                src = os.path.join(aqua_bin_dir, b)
                dst = os.path.join(target_bin, b)
                if os.path.islink(dst) or os.path.exists(dst):
                    os.remove(dst)
                os.symlink(src, dst)
        print(f"==> [Aqua] Successfully installed {pkg_entry}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        for app in sys.argv[1:]:
            install_github_app(app)
