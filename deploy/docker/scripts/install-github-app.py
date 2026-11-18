#!/usr/bin/env python3
import sys
import os
import json
import shutil
import urllib.request
import zipfile
import stat

STATE_FILE = os.environ.get("GITHUB_APPS_STATE", "/data/share/github-apps.json")

# A package in GITHUB_APPS - or a bare name typed into Settings - has no owner,
# and GitHub cannot resolve api.github.com/repos/zoxide (404). The standard aqua
# packages people ask for by name are mapped to the repository their releases
# live in; anything else has to be given as owner/repo.
BARE_NAME_REPOS = {
    "age": "FiloSottile/age",
    "apktool": "iBotPeaches/Apktool",
    "bat": "sharkdp/bat",
    "bottom": "ClementTsang/bottom",
    "btm": "ClementTsang/bottom",
    "delta": "dandavison/delta",
    "direnv": "direnv/direnv",
    "dust": "bootandy/dust",
    "eza": "eza-community/eza",
    "fd": "sharkdp/fd",
    "fzf": "junegunn/fzf",
    "gh": "cli/cli",
    "helix": "helix-editor/helix",
    "hx": "helix-editor/helix",
    "hyperfine": "sharkdp/hyperfine",
    "jadx": "skylot/jadx",
    "jq": "jqlang/jq",
    "just": "casey/just",
    "k9s": "derailed/k9s",
    "lazygit": "jesseduffield/lazygit",
    "neovim": "neovim/neovim",
    "nvim": "neovim/neovim",
    "rg": "BurntSushi/ripgrep",
    "ripgrep": "BurntSushi/ripgrep",
    "sops": "getsops/sops",
    "starship": "starship/starship",
    "yq": "mikefarah/yq",
    "zellij": "zellij-org/zellij",
    "zoxide": "ajeetdsouza/zoxide",
}


def split_spec(spec):
    """`skylot/jadx` is the latest release; `skylot/jadx@v1.5.1` is that tag."""
    spec = spec.strip()
    if "@" in spec:
        repo, tag = spec.rsplit("@", 1)
        return repo, (tag or None)
    return spec, None


def record_tag(repo, tag):
    """The verify step reports versions from this file, so it is written on
    every successful lookup - including the already-installed path, where the
    tag is known but nothing is fetched."""
    try:
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        state = {}
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                state = json.load(f)
        if not isinstance(state, dict):
            state = {}
        state[repo] = tag
        tmp = f"{STATE_FILE}.tmp"
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2, sort_keys=True)
            f.write("\n")
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        print(f"==> [WARN] Could not record {repo} at {tag}: {e}")


def record_tags(repo, requested, tag):
    """The verify step looks up the name that was requested, so a bare name is
    recorded beside the repository it resolved to."""
    record_tag(repo, tag)
    if requested and requested != repo:
        record_tag(requested, tag)


def fetch_release(repo, tag, headers):
    api_url = (f"https://api.github.com/repos/{repo}/releases/tags/{tag}" if tag
               else f"https://api.github.com/repos/{repo}/releases/latest")
    req = urllib.request.Request(api_url, headers=headers)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())


AQUA_ROOT = os.environ.get("AQUA_ROOT_DIR", "/data/aqua")
AQUA_PACKAGES_FILE = os.environ.get("AQUA_PACKAGES_STATE", "/data/aqua/packages.json")


def read_aqua_packages():
    """The proxy-managed packages, each with the tag it was installed at."""
    try:
        with open(AQUA_PACKAGES_FILE) as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    # Upgrade path: an earlier installer wrote the entries straight into
    # aqua.yaml, and this one has to keep resolving them.
    packages = {}
    try:
        with open(os.path.join(AQUA_ROOT, "aqua.yaml")) as f:
            for line in f:
                line = line.strip()
                if not line.startswith("- name: "):
                    continue
                entry = line[len("- name: "):]
                if "@" in entry:
                    repo, tag = entry.rsplit("@", 1)
                    packages[repo] = tag
    except OSError:
        pass
    return packages


def save_aqua_config(packages):
    """Write the registry and the single aqua.yaml generated from it.

    The config used to be rewritten with only the package being installed, so
    the next aqua install dropped the previous entry: the package stayed on
    disk, but its shim looked it up in a config that no longer listed it and
    answered "command is not found".
    """
    os.makedirs(AQUA_ROOT, exist_ok=True)
    registry_tmp = f"{AQUA_PACKAGES_FILE}.tmp"
    with open(registry_tmp, "w") as f:
        json.dump(packages, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(registry_tmp, AQUA_PACKAGES_FILE)

    yaml_path = os.path.join(AQUA_ROOT, "aqua.yaml")
    if not packages:
        if os.path.exists(yaml_path):
            os.remove(yaml_path)
        return yaml_path
    lines = ["---", "registries:", "  - type: standard", "    ref: v4.325.0", "packages:"]
    for repo in sorted(packages):
        lines.append(f"  - name: {repo}@{packages[repo]}")
    yaml_tmp = f"{yaml_path}.tmp"
    with open(yaml_tmp, "w") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(yaml_tmp, yaml_path)
    return yaml_path


def install_github_app(spec, target_bin="/data/bin", target_share="/data/share"):
    repo, requested = split_spec(spec)
    if not repo:
        return True
    requested_name = repo
    if "/" not in repo:
        repo = BARE_NAME_REPOS.get(repo.lower(), "")
        if not repo:
            print(f"==> [ERROR] {requested_name} needs an owner. Use owner/repo, for example ajeetdsouza/zoxide.")
            return False
    headers = {"User-Agent": "GitHub-App-Installer"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        data = fetch_release(repo, requested, headers)
    except Exception as e:
        print(f"==> [ERROR] Could not fetch release info for {repo}: {e}")
        return False

    tag = data.get("tag_name", requested or "latest")
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
            record_tags(repo, requested_name, tag)
            return True

        print(f"==> [GitHub App] Installing {repo} ({tag})...")
        asset = next((a for a in assets if a["name"].endswith(".zip") and "win" not in a["name"]), None)
        if not asset:
            print(f"==> [ERROR] {repo} has no release zip for this platform (release {tag}).")
            return False
        zip_tmp = f"/tmp/jadx-{tag}.zip"
        print(f"==> [GitHub App] Downloading {asset['name']} ({tag})...")
        urllib.request.urlretrieve(asset["browser_download_url"], zip_tmp)
        with zipfile.ZipFile(zip_tmp, 'r') as zip_ref:
            zip_ref.extractall(dest_dir)
        if os.path.exists(zip_tmp):
            os.remove(zip_tmp)
        jadx_bin = os.path.join(dest_dir, "bin", "jadx")
        if not os.path.exists(jadx_bin):
            print(f"==> [ERROR] {repo} archive did not contain bin/jadx.")
            return False
        os.chmod(jadx_bin, os.stat(jadx_bin).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
        if os.path.islink(link_path) or os.path.exists(link_path):
            os.remove(link_path)
        os.symlink(jadx_bin, link_path)
        record_tags(repo, requested_name, tag)
        print(f"==> [GitHub App] Successfully installed jadx {tag} -> {link_path}")
        return True

    # Special handler: apktool
    if "apktool" in repo_lower:
        jar_dest = os.path.join(target_share, f"apktool-{tag}.jar")
        wrapper_path = os.path.join(target_bin, "apktool")
        if os.path.exists(jar_dest) and os.path.exists(wrapper_path):
            print(f"==> [GitHub App] apktool {tag} is already installed.")
            record_tags(repo, requested_name, tag)
            return True

        print(f"==> [GitHub App] Installing {repo} ({tag})...")
        asset = next((a for a in assets if a["name"].endswith(".jar")), None)
        if not asset:
            print(f"==> [ERROR] {repo} has no release jar (release {tag}).")
            return False
        print(f"==> [GitHub App] Downloading {asset['name']} ({tag})...")
        urllib.request.urlretrieve(asset["browser_download_url"], jar_dest)
        with open(wrapper_path, "w") as f:
            f.write(f'#!/bin/sh\nexec java -Xmx1024M -Dfile.encoding=UTF-8 -jar "{jar_dest}" "$@"\n')
        os.chmod(wrapper_path, 0o755)
        record_tags(repo, requested_name, tag)
        print(f"==> [GitHub App] Successfully installed apktool {tag} -> {wrapper_path}")
        return True

    # Fallback to aqua if it's a standard aqua package
    import subprocess
    pkg_entry = f"{repo}@{tag}"
    print(f"==> [Aqua] Attempting aqua install for {pkg_entry}...")
    previous = read_aqua_packages()
    packages = dict(previous)
    packages[repo] = tag
    yaml_path = save_aqua_config(packages)
    res = subprocess.run(["aqua", "install", "-l", "-a", "-c", yaml_path], env=dict(os.environ, AQUA_ROOT_DIR=AQUA_ROOT))
    if res.returncode != 0:
        # Packages that already worked keep their config: a failed fetch must
        # not empty the file every other shim is resolved through.
        save_aqua_config(previous)
        print(f"==> [ERROR] aqua could not install {pkg_entry} (exit {res.returncode}).")
        return False
    aqua_bin_dir = "/data/aqua/bin"
    if os.path.exists(aqua_bin_dir):
        for b in os.listdir(aqua_bin_dir):
            src = os.path.join(aqua_bin_dir, b)
            dst = os.path.join(target_bin, b)
            if os.path.islink(dst) or os.path.exists(dst):
                os.remove(dst)
            os.symlink(src, dst)
    record_tags(repo, requested_name, tag)
    print(f"==> [Aqua] Successfully installed {pkg_entry}")
    return True


def uninstall_github_app(spec, target_bin="/data/bin", target_share="/data/share"):
    """Remove what install_github_app placed, including the aqua cache.

    There is no `aqua uninstall`; a package is a downloaded release plus the
    proxies that point at it, so both are deleted here by name.
    """
    repo, _ = split_spec(spec)
    requested = repo
    if "/" not in repo:
        repo = BARE_NAME_REPOS.get(repo.lower(), "")
    if not repo:
        print(f"==> [ERROR] {requested} needs an owner. Use owner/repo, for example ajeetdsouza/zoxide.")
        return False

    name = repo.split("/")[-1].lower()
    aqua_root = os.environ.get("AQUA_ROOT_DIR", "/data/aqua")
    removed = []

    def drop(target):
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        elif os.path.islink(target) or os.path.exists(target):
            os.remove(target)
        else:
            return
        removed.append(target)

    drop(os.path.join(target_bin, name))
    # aqua keeps its own proxy beside the copy the installer linked into PATH.
    drop(os.path.join(aqua_root, "bin", name))
    drop(os.path.join(aqua_root, "pkgs", "github_release", "github.com", repo))

    # jadx and apktool keep their payload under /data/share.
    if name in ("jadx", "apktool") and os.path.isdir(target_share):
        for entry in os.listdir(target_share):
            if entry.startswith(f"{name}-"):
                drop(os.path.join(target_share, entry))

    # Remove this package from the shared config instead of deleting the file:
    # uninstalling one aqua package must not break the others.
    packages = read_aqua_packages()
    if repo in packages:
        packages.pop(repo, None)
        save_aqua_config(packages)

    # The verify step reads the recorded tag, so the name has to leave the
    # state file or a reinstall would look like it is still present.
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                state = json.load(f)
            if isinstance(state, dict):
                for key in {repo, requested}:
                    state.pop(key, None)
                with open(STATE_FILE, "w") as f:
                    json.dump(state, f, indent=2, sort_keys=True)
                    f.write("\n")
    except Exception as e:
        print(f"==> [WARN] Could not update {STATE_FILE}: {e}")

    if not removed:
        print(f"==> [GitHub App] Nothing to remove for {repo}; it was not installed here.")
    else:
        for target in removed:
            print(f"==> [GitHub App] Removed {target}")
    return True


if __name__ == "__main__":
    args = sys.argv[1:]
    uninstall = bool(args) and args[0] == "--uninstall"
    if uninstall:
        args = args[1:]
    action = uninstall_github_app if uninstall else install_github_app
    ok = True
    for app in args:
        if not action(app):
            ok = False
    sys.exit(0 if ok else 1)
