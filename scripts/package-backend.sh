#!/usr/bin/env bash
set -euo pipefail

# Package AH32 backend into a platform-specific tar.gz (Linux/macOS).
#
# Usage:
#   bash scripts/package-backend.sh --platform linux-x64 --out-dir dist
#   bash scripts/package-backend.sh --platform macos-arm64 --out-dir dist
#
# Prereqs:
# - Python 3.11+
# - `pyinstaller` available in current environment (recommended: `pip install -e ".[packaging]"`)

platform=""
out_dir="dist"
app_name="Ah32"
python_exe=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      platform="${2:-}"; shift 2 ;;
    --out-dir)
      out_dir="${2:-}"; shift 2 ;;
    --app-name)
      app_name="${2:-}"; shift 2 ;;
    --python)
      python_exe="${2:-}"; shift 2 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2 ;;
  esac
done

if [[ -z "$platform" ]]; then
  echo "Missing --platform" >&2
  exit 2
fi

case "$platform" in
  linux-x64|linux-arm64|macos-x64|macos-arm64) ;;
  *)
    echo "Unsupported --platform: $platform" >&2
    exit 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$repo_root/$out_dir"
out_dir_path="$(cd "$repo_root/$out_dir" && pwd)"

if [[ -z "$python_exe" ]]; then
  if [[ -x "$repo_root/.venv/bin/python" ]]; then
    python_exe="$repo_root/.venv/bin/python"
  else
    python_exe="python"
  fi
fi

echo "=== Package Backend (POSIX) ==="
echo "RepoRoot : $repo_root"
echo "Platform : $platform"
echo "OutDir   : $out_dir_path"
echo "AppName  : $app_name"
echo "Python   : $python_exe"
echo

cd "$repo_root"

echo "[1/3] Build with PyInstaller..."
rm -rf build "dist/$app_name" || true

"$python_exe" -m PyInstaller -y \
  --name "$app_name" \
  --paths src \
  -m ah32.launcher

py_dist="$repo_root/dist/$app_name"
if [[ ! -d "$py_dist" ]]; then
  echo "PyInstaller output not found: $py_dist" >&2
  exit 1
fi

echo "[2/3] Stage files..."
stage_root="$repo_root/_release/backend/$platform"
rm -rf "$stage_root"
mkdir -p "$stage_root"

cp -R "$py_dist" "$stage_root/$app_name"
if [[ -f "$repo_root/.env.example" ]]; then
  cp "$repo_root/.env.example" "$stage_root/.env.example"
fi

cat > "$stage_root/README.txt" <<'TXT'
AH32 Backend

1) Copy .env.example to .env and set at least:
   - DEEPSEEK_API_KEY=...

2) Run the bundled executable from the extracted folder.

Notes:
- Default bind: http://127.0.0.1:5123
- Logs: ah32_launcher.log (in the same folder)
TXT

echo "[3/3] Tarball..."
tar_name="Ah32Backend-$platform.tar.gz"
tar_path="$out_dir_path/$tar_name"
rm -f "$tar_path"

(
  cd "$stage_root"
  tar -czf "$tar_path" .
)

echo "[OK] Wrote: $tar_path"
