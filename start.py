#!/usr/bin/env python3
"""
Ah32 启动脚本 - 独立模式
"""
from __future__ import annotations

import subprocess
import sys
import os
import getopt
import threading
import time
import signal
from datetime import datetime
from pathlib import Path
import socket

# Load .env file (strict: must exist and include AH32_EMBEDDING_MODEL)
try:
    from dotenv import load_dotenv
except ImportError as e:
    raise RuntimeError("python-dotenv is required to load .env; please install it.") from e

env_file = Path(__file__).parent / ".env"
if not env_file.exists():
    raise RuntimeError(f".env file not found: {env_file}. Create it in the repo root.")

load_dotenv(env_file, override=True)
if not os.environ.get("AH32_EMBEDDING_MODEL"):
    raise RuntimeError("AH32_EMBEDDING_MODEL is missing in .env; please configure it.")

# -----------------------------------------------------------------------------
# Runtime dirs (logs/pid)
_IS_WINDOWS = sys.platform.startswith("win")

# Keep Windows & Linux aligned by default: use `logs/` for this script output
# (foreground logs + daemon logs + pidfile). The backend itself may still write
# its own runtime artifacts under `storage/`.
LOG_DIR = Path("logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Allow overriding where this script writes pid/daemon logs.
RUN_DIR = Path(os.environ.get("AH32_RUN_DIR") or str(LOG_DIR))
RUN_DIR.mkdir(parents=True, exist_ok=True)

# Legacy Linux daemon output path (older agent runs)
LEGACY_RUN_DIR = Path("storage/logs")

# Fixed log files for each service (foreground)
BACKEND_LOG = LOG_DIR / "backend.log"
FRONTEND_LOG = LOG_DIR / "frontend.log"
WPS_LOG = LOG_DIR / "wps.log"

# Daemon-mode files (backend-only)
BACKEND_PID_FILE = RUN_DIR / "backend.pid"
BACKEND_DAEMON_LOG = RUN_DIR / "backend.nohup.log"


def _port_open(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.3)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def _pid_cmdline(pid: int) -> str:
    if _IS_WINDOWS:
        return ""
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        # cmdline is NUL-delimited
        return raw.replace(b"\x00", b" ").decode("utf-8", errors="replace").strip()
    except Exception:
        return ""


def _looks_like_ah32_backend(pid: int) -> bool:
    cmd = _pid_cmdline(pid)
    if not cmd:
        return False
    return (
        "ah32.server.main" in cmd
        or "uvicorn" in cmd and "ah32.server.main:app" in cmd
        or "ah32.server.main:app" in cmd
    )


def _find_listening_pids(port: int) -> list[int]:
    """Best-effort: return PIDs listening on 127.0.0.1:<port>."""
    if _IS_WINDOWS:
        return []
    try:
        result = subprocess.run(
            ["ss", "-ltnp"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        out = result.stdout or ""
    except Exception:
        return []

    pids: set[int] = set()
    for line in out.splitlines():
        if f":{port} " not in line and f":{port}\n" not in line and f":{port}\t" not in line:
            continue
        # Example: users:(("python",pid=99943,fd=21))
        for token in line.split("pid=")[1:]:
            num = ""
            for ch in token:
                if ch.isdigit():
                    num += ch
                else:
                    break
            if num:
                try:
                    pids.add(int(num))
                except Exception:
                    pass
    return sorted(pids)


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        if _IS_WINDOWS:
            # Best-effort: Windows support is not the primary goal here.
            os.kill(pid, 0)
        else:
            os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_pidfile(pid_file: Path) -> int | None:
    try:
        raw = pid_file.read_text(encoding="utf-8").strip()
        if not raw:
            return None
        pid = int(raw)
        return pid
    except Exception:
        return None


def _read_any_pidfile() -> tuple[int | None, Path | None]:
    """Read pid from current or legacy location (for backward compatibility)."""
    for p in (BACKEND_PID_FILE, LEGACY_RUN_DIR / "backend.pid"):
        pid = _read_pidfile(p)
        if pid:
            return pid, p
    return None, None


def _write_pidfile(pid_file: Path, pid: int) -> None:
    pid_file.parent.mkdir(parents=True, exist_ok=True)
    pid_file.write_text(f"{pid}\n", encoding="utf-8")


def _remove_pidfile(pid_file: Path) -> None:
    try:
        pid_file.unlink(missing_ok=True)
    except Exception:
        pass


def _make_backend_env() -> dict:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path.cwd() / "src")
    env["PYTHONWARNINGS"] = "ignore::DeprecationWarning"
    env["NO_PROXY"] = "127.0.0.1,localhost"
    env.setdefault("HTTP_PROXY", "")
    env.setdefault("HTTPS_PROXY", "")

    # These envs avoid common Windows GPU/proxy issues. Harmless on Linux.
    env.setdefault("CUDA_VISIBLE_DEVICES", "")
    env.setdefault("HIP_VISIBLE_DEVICES", "")

    # Avoid accidental override from global/system env.
    # This project prefers keys in `.env` (AH32_OPENAI_API_KEY / DEEPSEEK_API_KEY).
    if env.get("AH32_OPENAI_API_KEY") or env.get("DEEPSEEK_API_KEY"):
        env.pop("OPENAI_API_KEY", None)
        env.pop("DASHSCOPE_API_KEY", None)

    env.setdefault("RELOAD", os.environ.get("RELOAD", "false"))
    env.setdefault("LOG_LEVEL", os.environ.get("LOG_LEVEL", "DEBUG"))
    # Force UTF-8 for all backend subprocess output (avoid mojibake in logs).
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    return env


def _tail_file(path: Path, last_n: int = 200) -> int:
    if not path.exists():
        print(f"[ERROR] Log file not found: {path}")
        return 1

    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
            for line in lines[-last_n:]:
                print(line.rstrip("\n"))
    except Exception as e:
        print(f"[ERROR] Failed to read log file: {e}")
        return 1

    print(f"\n[INFO] Tailing: {path} (Ctrl+C to exit)")
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            f.seek(0, os.SEEK_END)
            while True:
                line = f.readline()
                if not line:
                    time.sleep(0.2)
                    continue
                print(line.rstrip("\n"))
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print(f"[ERROR] Tail failed: {e}")
        return 1


def backend_status() -> int:
    pid, pid_path = _read_any_pidfile()
    listeners = _find_listening_pids(5123)
    if not pid:
        print(f"[STATUS] backend: not running (pidfile missing: {BACKEND_PID_FILE})")
        if listeners:
            print(f"[WARN] port 5123 is in use by pid(s): {listeners}")
        return 1
    if _pid_is_running(pid):
        print(f"[STATUS] backend: running (pid={pid})")
        if pid_path and pid_path != BACKEND_PID_FILE:
            print(f"[INFO] pidfile: {pid_path} (legacy)")
        else:
            print(f"[INFO] pidfile: {BACKEND_PID_FILE}")

        # Prefer current daemon log, fall back to legacy.
        daemon_log = BACKEND_DAEMON_LOG if BACKEND_DAEMON_LOG.exists() else (LEGACY_RUN_DIR / "backend.nohup.log")
        print(f"[INFO] daemon log: {daemon_log}")
        if listeners and pid not in listeners:
            print(f"[WARN] port 5123 is held by pid(s): {listeners} (pidfile pid={pid})")
        return 0
    print(f"[STATUS] backend: stale pidfile (pid={pid})")
    if listeners:
        print(f"[WARN] port 5123 is in use by pid(s): {listeners}")
    return 1


def backend_stop(grace_seconds: float = 10.0) -> int:
    pid, pid_path = _read_any_pidfile()
    listeners = _find_listening_pids(5123)

    if pid and _pid_is_running(pid):
        print(f"[INFO] stopping backend (pid={pid}) ...")
        try:
            if _IS_WINDOWS:
                os.kill(pid, signal.SIGTERM)
            else:
                # Kill the whole process group (uvicorn may spawn children).
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGTERM)
        except Exception as e:
            print(f"[WARN] failed to terminate pid={pid}: {e}")
    else:
        if pid:
            print(f"[INFO] backend pidfile exists but process not running (pid={pid})")
        else:
            print(f"[INFO] backend not running (no pidfile: {BACKEND_PID_FILE})")

    deadline = time.time() + grace_seconds
    while time.time() < deadline:
        if not listeners and not (pid and _pid_is_running(pid)):
            break
        listeners = _find_listening_pids(5123)
        time.sleep(0.2)

    # If port is still in use, try to stop the actual listener (best-effort, Linux only).
    listeners = _find_listening_pids(5123)
    if listeners:
        safe_targets = [p for p in listeners if _looks_like_ah32_backend(p)]
        if safe_targets:
            print(f"[WARN] port 5123 still in use, killing backend pid(s): {safe_targets}")
            for p in safe_targets:
                try:
                    pgid = os.getpgid(p)
                    os.killpg(pgid, signal.SIGKILL)
                except Exception:
                    try:
                        os.kill(p, signal.SIGKILL)
                    except Exception:
                        pass

    # Remove pidfiles (current + legacy)
    _remove_pidfile(BACKEND_PID_FILE)
    _remove_pidfile(LEGACY_RUN_DIR / "backend.pid")
    if not _port_open("127.0.0.1", 5123):
        print("[OK] backend stopped")
        return 0
    print("[WARN] port 5123 still open; backend may still be running")
    return 0


def start_backend_daemon() -> int:
    pid, pid_path = _read_any_pidfile()
    if pid and _pid_is_running(pid):
        print(f"[INFO] backend already running (pid={pid})")
        if pid_path and pid_path != BACKEND_PID_FILE:
            print(f"[INFO] pidfile: {pid_path} (legacy)")
        return 0

    # Avoid starting a duplicate instance when the fixed port is already occupied.
    if _port_open("127.0.0.1", 5123):
        listeners = _find_listening_pids(5123)
        print(f"[ERROR] port 5123 already in use (pid(s)={listeners}); stop it first")
        return 1

    BACKEND_DAEMON_LOG.parent.mkdir(parents=True, exist_ok=True)
    env = _make_backend_env()
    # Keep reload toggle single-sourced from `.env` / env var. Daemon + reload is unsafe.
    if str(env.get("RELOAD", "false")).lower() in ("true", "1", "yes"):
        print("[ERROR] RELOAD=true is not supported in --daemon mode; run foreground instead.")
        return 1

    with BACKEND_DAEMON_LOG.open("a", encoding="utf-8") as lf:
        lf.write(f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] starting backend (daemon)\n")
        lf.flush()
        process = subprocess.Popen(
            [sys.executable, "-m", "ah32.server.main"],
            env=env,
            stdout=lf,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    _write_pidfile(BACKEND_PID_FILE, process.pid)
    print(f"[OK] backend daemon started (pid={process.pid})")
    print(f"[INFO] pidfile: {BACKEND_PID_FILE}")
    print(f"[INFO] log:    {BACKEND_DAEMON_LOG}")
    return 0


def start_backend_foreground() -> subprocess.Popen | None:
    """Start backend and stream logs to console and file (foreground)."""
    service = "backend"
    write_log(service, f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting backend service")

    env = _make_backend_env()
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "ah32.server.main"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
        print(f"[OK] Backend started on port 5123 (PID: {process.pid})")
        print(f"[INFO] Log file: {BACKEND_LOG}")

        def log_output():
            try:
                assert process.stdout is not None
                for line in iter(process.stdout.readline, ""):
                    if line:
                        msg = f"[BACKEND] {line.strip()}"
                        write_log(service, msg)
                        print(msg)
            except Exception as e:
                write_log(service, f"[BACKEND] Log read error: {e}")

        thread = threading.Thread(target=log_output, daemon=True)
        thread.start()
        return process
    except Exception as e:
        print(f"[ERROR] Backend failed: {e}")
        write_log(service, f"Backend error: {e}")
        return None


def write_log(service, message):
    """Write to service-specific log file"""
    LOG_DIR.mkdir(exist_ok=True)
    try:
        if service == 'backend':
            with open(BACKEND_LOG, 'a', encoding='utf-8') as f:
                f.write(f"{message}\n")
        elif service == 'frontend':
            with open(FRONTEND_LOG, 'a', encoding='utf-8') as f:
                f.write(f"{message}\n")
        elif service == 'wps':
            with open(WPS_LOG, 'a', encoding='utf-8') as f:
                f.write(f"{message}\n")
    except Exception as e:
        print(f"Log write failed: {e}")

def start_backend():
    """Start backend service"""
    return start_backend_foreground() is not None

def start_frontend():
    """Start frontend service"""
    service = 'frontend'
    write_log(service, f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting frontend service")
    original_dir = Path.cwd()
    bid_ui_dir = Path.cwd() / "ah32-ui-next"

    # Check if ah32-ui-next directory exists
    if not bid_ui_dir.exists():
        error_msg = f"[ERROR] ah32-ui-next directory not found: {bid_ui_dir}"
        print(error_msg)
        write_log(service, error_msg)
        return False

    os.chdir(bid_ui_dir)

    # Fix npm path
    npm_paths = [
        r"C:\nvm4w\nodejs\npm.cmd",
        r"C:\nvm4w\nodejs\npm",
        r"C:\nvm4w\nodejs\bin\npm.cmd",
        "npm"
    ]
    npm_cmd = None
    for path in npm_paths:
        if os.path.exists(path) or path == "npm":
            npm_cmd = path
            write_log(service, f"[INFO] Using npm: {npm_cmd}")
            break

    if not npm_cmd:
        error_msg = f"[ERROR] npm not found. Tried paths: {npm_paths}"
        print(error_msg)
        write_log(service, error_msg)
        return False

    write_log(service, f"[INFO] Current directory: {os.getcwd()}")

    # Set environment variables
    env = os.environ.copy()
    env["PATH"] = r"C:\nvm4w\nodejs\bin;" + env.get("PATH", "")
    env["NODE_PATH"] = r"C:\nvm4w\nodejs"

    try:
        process = subprocess.Popen(
            [npm_cmd, "run", "dev"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            start_new_session=True
        )
        print(f"[OK] Frontend started on port 3889 (PID: {process.pid})")
        print(f"[INFO] Log file: {FRONTEND_LOG}")

        # Read output in new thread and write to log
        def log_output():
            try:
                for line in iter(process.stdout.readline, ''):
                    if line:
                        msg = f"[FRONTEND] {line.strip()}"
                        write_log(service, msg)
                        print(msg)
            except Exception as e:
                write_log(service, f"[FRONTEND] Log read error: {e}")

        thread = threading.Thread(target=log_output, daemon=True)
        thread.start()
        return True
    except FileNotFoundError:
        error_msg = "[ERROR] npm not found. Please install Node.js"
        print(error_msg)
        write_log(service, error_msg)
        return False
    except Exception as e:
        error_msg = f"[ERROR] Frontend error: {e}"
        print(error_msg)
        write_log(service, error_msg)
        return False
    finally:
        os.chdir(original_dir)

def start_wps_debug():
    """Start WPS debug"""
    service = 'wps'
    write_log(service, f"\n[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting WPS debug")
    original_dir = Path.cwd()
    bid_ui_dir = Path.cwd() / "ah32-ui-next"

    if not bid_ui_dir.exists():
        error_msg = f"[ERROR] ah32-ui-next directory not found: {bid_ui_dir}"
        print(error_msg)
        write_log(service, error_msg)
        return False

    os.chdir(bid_ui_dir)

    wpsjs_main = "./node_modules/wpsjs/src/index.js"
    node_exe = r"C:\nvm4w\nodejs\node.exe"

    if not os.path.exists(wpsjs_main):
        error_msg = f"[ERROR] wpsjs main file not found: {wpsjs_main}"
        print(error_msg)
        write_log(service, error_msg)
        return False

    if not os.path.exists(node_exe):
        error_msg = f"[ERROR] Node.js not found: {node_exe}"
        print(error_msg)
        write_log(service, error_msg)
        return False

    write_log(service, f"[INFO] Using Node.js: {node_exe}")
    write_log(service, f"[INFO] Using wpsjs: {wpsjs_main}")

    try:
        process = subprocess.Popen(
            [node_exe, wpsjs_main, "debug"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding='utf-8',
            errors='replace',
            start_new_session=True
        )
        print(f"[OK] WPS debug started (PID: {process.pid})")
        print(f"[INFO] Log file: {WPS_LOG}")

        # Read output in new thread and write to log
        def log_output():
            try:
                for line in iter(process.stdout.readline, ''):
                    if line:
                        msg = f"[WPS] {line.strip()}"
                        write_log(service, msg)
                        print(msg)
            except Exception as e:
                write_log(service, f"[WPS] Log read error: {e}")

        thread = threading.Thread(target=log_output, daemon=True)
        thread.start()
        return True
    except FileNotFoundError:
        error_msg = "[ERROR] wpsjs not found. Please install: npm install -g wpsjs"
        print(error_msg)
        write_log(service, error_msg)
        return False
    except Exception as e:
        error_msg = f"[ERROR] WPS debug error: {e}"
        print(error_msg)
        write_log(service, error_msg)
        return False
    finally:
        os.chdir(original_dir)

def main():
    log_mode = 'auto'
    services = []
    service_threads = []
    daemon_mode = False
    action = None  # stop/status/tail

    # Help
    if len(sys.argv) > 1 and sys.argv[1] in ['-h', '--help', 'help']:
        print("Ah32 Startup Script")
        print("\nUsage:")
        print("  python start.py [options]")
        print("\nBackend Daemon (Linux recommended):")
        print("  --daemon        Start backend in background and exit (writes pid/log)")
        print("  --stop          Stop backend started by --daemon")
        print("  --status        Show backend daemon status")
        print("  --tail          Tail backend daemon log")
        print("\nServices (any combination):")
        print("  -B             Start backend")
        print("  -F             Start frontend")
        print("  -D             Start WPS debug")
        print("\nLog Options:")
        print("  -c             Clear log files")
        print("  -a             Append to log files")
        print("\nExamples:")
        print("  python start.py -B              # Backend only")
        print("  python start.py -F              # Frontend only")
        print("  python start.py -B -F           # Backend + Frontend")
        print("  python start.py -B -F -D        # All services")
        print("  python start.py -B -F -c        # Clear logs, start services")
        sys.exit(0)

    # Parse parameters
    try:
        opts, args = getopt.getopt(
            sys.argv[1:],
            "acBFDdstl",
            ["help", "daemon", "stop", "status", "tail"],
        )
        for opt, arg in opts:
            if opt == '-a':
                log_mode = 'append'
            elif opt == '-c':
                log_mode = 'clear'
            elif opt in ('-d', '--daemon'):
                daemon_mode = True
            elif opt in ('-s', '--stop'):
                action = 'stop'
            elif opt in ('-t', '--status'):
                action = 'status'
            elif opt in ('-l', '--tail'):
                action = 'tail'
            elif opt == '-B':
                if 'backend' not in services:
                    services.append('backend')
            elif opt == '-F':
                if 'frontend' not in services:
                    services.append('frontend')
            elif opt == '-D':
                if 'wps' not in services:
                    services.append('wps')
            elif opt == '-h':
                print("Use: python start.py --help")
                sys.exit(0)
    except getopt.GetoptError as e:
        print(f"ERROR: Invalid parameters: {e}")
        print("Use: python start.py --help")
        sys.exit(1)

    if action == "stop":
        raise SystemExit(backend_stop())
    if action == "status":
        raise SystemExit(backend_status())
    if action == "tail":
        # Prefer daemon log; fallback to legacy daemon log; then foreground log.
        if BACKEND_DAEMON_LOG.exists():
            path = BACKEND_DAEMON_LOG
        elif (LEGACY_RUN_DIR / "backend.nohup.log").exists():
            path = LEGACY_RUN_DIR / "backend.nohup.log"
        else:
            path = BACKEND_LOG
        raise SystemExit(_tail_file(path))

    if daemon_mode:
        # Daemon mode focuses on backend-only and exits immediately.
        if services and services != ["backend"]:
            print("[WARN] --daemon only supports backend; ignoring other services")
        raise SystemExit(start_backend_daemon())

    # Default to backend if no services specified
    if not services:
        services = ['backend']

    # Handle log mode
    if log_mode == 'clear':
        for log_file in [BACKEND_LOG, FRONTEND_LOG, WPS_LOG]:
            if log_file.exists():
                log_file.unlink()
        print(f"[OK] All log files cleared")
    elif log_mode == 'append':
        print(f"[OK] Append mode - keeping existing logs")
    else:
        print(f"[OK] Auto mode - keeping existing logs")

    print(f"\nAh32 Starting: {', '.join(services)}")
    print("-" * 50)

    # Start services in parallel
    started_processes: list[subprocess.Popen] = []
    for service in services:
        def start_service_in_thread(service_name):
            try:
                if service_name == 'backend':
                    p = start_backend_foreground()
                    if p is not None:
                        started_processes.append(p)
                elif service_name == 'frontend':
                    start_frontend()
                elif service_name == 'wps':
                    start_wps_debug()
            except Exception as e:
                print(f"\n[ERROR] Service {service_name} error: {e}")
                write_log(service_name, f"Service error: {e}")

        thread = threading.Thread(target=start_service_in_thread, args=(service,), daemon=True)
        service_threads.append(thread)
        thread.start()
        time.sleep(0.5)  # Small delay between starts

    print(f"\n[OK] Started {len(service_threads)} services")
    print(f"Logs:")
    print(f"  Backend:  {BACKEND_LOG}")
    print(f"  Frontend: {FRONTEND_LOG}")
    print(f"  WPS:     {WPS_LOG}")
    print("\nPress Ctrl+C to stop all services")
    sys.stdout.flush()

    # Keep main thread running
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n\n[INFO] Stopping all services...")
        # Best-effort stop children (they are started in new sessions, so Ctrl+C won't reach them).
        for p in started_processes:
            try:
                p.terminate()
            except Exception:
                pass
        write_log('backend', f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Services stopped")

if __name__ == "__main__":
    main()
