//! `--install-agent-desktop`: downloads the matching platform release
//! tarball directly from `vercel-labs/agent-desktop`'s GitHub Releases,
//! verifies its published sha256, and extracts it next to the companion's
//! stored device credential - no Node/npm required, since GitHub Releases
//! already publishes self-contained per-platform tarballs (confirmed:
//! each one contains only `agent-desktop` and, on macOS, the separate
//! `agent-desktop-macos-helper` binary it needs for the real accessibility/
//! screen-recording/automation API calls - no launcher wrapper, no other
//! files).

use std::path::PathBuf;

const RELEASES_API: &str = "https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest";

/// Directory the installed binaries are placed in, and the default
/// `--executable` path once installed. Kept alongside (not inside) the
/// credential state directory so a user who deletes `device.json` by hand
/// to re-pair does not also delete the installed binary.
pub fn install_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("gajae-agent-desktop-companion").join("agent-desktop")
}

pub fn installed_executable_path() -> PathBuf {
    let name = if cfg!(windows) { "agent-desktop.exe" } else { "agent-desktop" };
    install_dir().join(name)
}

/// The release tarball's platform suffix, matching
/// `agent-desktop-v<version>-<target-triple>.tar.gz` asset names.
fn target_triple() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("windows", "aarch64") => Ok("aarch64-pc-windows-msvc"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        (os, arch) => Err(format!("agent-desktop has no published release for {os}/{arch}; install it manually from https://github.com/vercel-labs/agent-desktop/releases")),
    }
}

pub async fn install() -> Result<PathBuf, String> {
    let triple = target_triple()?;
    println!("[info] Looking up the latest agent-desktop release for {triple}...");
    let client = reqwest::Client::builder()
        .user_agent("gajae-agent-desktop-companion")
        .build()
        .map_err(|cause| format!("failed to build HTTP client: {cause}"))?;

    let release: serde_json::Value = client.get(RELEASES_API).send().await
        .map_err(|cause| format!("failed to reach GitHub releases API: {cause}"))?
        .error_for_status().map_err(|cause| format!("GitHub releases API returned an error: {cause}"))?
        .json().await.map_err(|cause| format!("unexpected GitHub releases API response: {cause}"))?;
    let version = release.get("tag_name").and_then(serde_json::Value::as_str).unwrap_or("latest");
    let asset_name = format!("agent-desktop-{version}-{triple}.tar.gz");
    let assets = release.get("assets").and_then(serde_json::Value::as_array).cloned().unwrap_or_default();
    let tarball_url = assets.iter()
        .find(|asset| asset.get("name").and_then(serde_json::Value::as_str) == Some(asset_name.as_str()))
        .and_then(|asset| asset.get("browser_download_url")).and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("release {version} has no asset named {asset_name}"))?
        .to_string();
    let checksums_url = assets.iter()
        .find(|asset| asset.get("name").and_then(serde_json::Value::as_str) == Some("checksums.txt"))
        .and_then(|asset| asset.get("browser_download_url")).and_then(serde_json::Value::as_str)
        .ok_or_else(|| format!("release {version} has no checksums.txt"))?
        .to_string();

    println!("[info] Downloading {asset_name} ({version})...");
    let tarball = client.get(&tarball_url).send().await
        .map_err(|cause| format!("download failed: {cause}"))?
        .error_for_status().map_err(|cause| format!("download failed: {cause}"))?
        .bytes().await.map_err(|cause| format!("download failed: {cause}"))?;

    println!("[info] Verifying checksum...");
    let checksums = client.get(&checksums_url).send().await
        .map_err(|cause| format!("failed to fetch checksums.txt: {cause}"))?
        .error_for_status().map_err(|cause| format!("failed to fetch checksums.txt: {cause}"))?
        .text().await.map_err(|cause| format!("failed to fetch checksums.txt: {cause}"))?;
    let expected = checksums.lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            if name == asset_name { Some(hash.to_string()) } else { None }
        })
        .ok_or_else(|| format!("checksums.txt has no entry for {asset_name}"))?;
    let actual = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&tarball);
        format!("{:x}", hasher.finalize())
    };
    if !actual.eq_ignore_ascii_case(&expected) {
        return Err(format!("checksum mismatch for {asset_name}: expected {expected}, got {actual} - refusing to extract a tarball that does not match its published checksum"));
    }

    let target = install_dir();
    tokio::fs::create_dir_all(&target).await.map_err(|cause| format!("failed to create {}: {cause}", target.display()))?;
    println!("[info] Extracting to {}...", target.display());
    extract(&tarball, &target)?;

    let executable = installed_executable_path();
    if !cfg!(windows) {
        set_executable(&executable)?;
        let helper = target.join("agent-desktop-macos-helper");
        if helper.exists() {
            set_executable(&helper)?;
        }
    }
    println!("[info] Installed agent-desktop {version} to {}", executable.display());
    println!("[info] Pass --executable={} (or move it onto PATH) so the companion uses it, or just rerun with --server - the companion now checks here automatically when \"agent-desktop\" is not on PATH.", executable.display());
    Ok(executable)
}

fn extract(tarball: &[u8], target: &std::path::Path) -> Result<(), String> {
    let decompressed = flate2::read::GzDecoder::new(tarball);
    let mut archive = tar::Archive::new(decompressed);
    archive.unpack(target).map_err(|cause| format!("failed to extract archive: {cause}"))?;
    Ok(())
}

#[cfg(unix)]
fn set_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(path).map_err(|cause| cause.to_string())?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(path, permissions).map_err(|cause| cause.to_string())
}

#[cfg(not(unix))]
fn set_executable(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

/// Checked by the default `--executable` resolution: if the bundled
/// install exists, prefer it over relying on a bare "agent-desktop" being
/// on `PATH` at all - this is what makes a prior `--install-agent-desktop`
/// actually take effect without the user having to pass `--executable`
/// (or edit PATH) by hand every time.
pub fn find_installed() -> Option<PathBuf> {
    let path = installed_executable_path();
    if path.exists() { Some(path) } else { None }
}
