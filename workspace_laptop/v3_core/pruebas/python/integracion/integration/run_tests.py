"""
Integration test runner and evidence collector.

Usage:
    python tests/integration/run_tests.py

This script runs all integration tests, captures output, and writes
.evidence files to .sisyphus/evidence/.
"""
import os
import subprocess
import sys
import time
from datetime import datetime

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
_EVIDENCE_DIR = os.path.join(_PROJECT_ROOT, ".sisyphus", "evidence")


def ensure_evidence_dir():
    os.makedirs(_EVIDENCE_DIR, exist_ok=True)


def run_pytest():
    """Run pytest integration suite and capture output."""
    cmd = [
        sys.executable,
        "-m",
        "pytest",
        os.path.join(_PROJECT_ROOT, "tests", "integration"),
        "-v",
        "--tb=short",
        "--color=no",
    ]
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=_PROJECT_ROOT)
    return result


def save_evidence(suffix, stdout, stderr, returncode):
    """Write test output to evidence file."""
    ensure_evidence_dir()
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(_EVIDENCE_DIR, f"task-14-{suffix}-{ts}.txt")
    with open(path, "w") as f:
        f.write(f"Timestamp: {datetime.now().isoformat()}\n")
        f.write(f"Return code: {returncode}\n")
        f.write("=" * 60 + "\n")
        f.write("STDOUT:\n")
        f.write(stdout or "(empty)\n")
        f.write("=" * 60 + "\n")
        f.write("STDERR:\n")
        f.write(stderr or "(empty)\n")
    print(f"Evidence saved: {path}")
    return path


def check_backend_health():
    """Quick smoke test that backend is alive."""
    import urllib.request

    url = os.getenv("BACKEND_URL", "http://localhost:3003") + "/api/status"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def main():
    print("=" * 60)
    print("Chipi v3 — Full Pipeline Integration Test Runner")
    print("=" * 60)

    # 1. Check backend
    if check_backend_health():
        print("Backend: ONLINE")
    else:
        print("Backend: OFFLINE (some tests will skip)")

    # 2. Run Python integration tests
    result = run_pytest()
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)

    # 3. Save evidence
    suffix = "pytest"
    if result.returncode == 0:
        suffix += "-pass"
    else:
        suffix += "-partial"
    save_evidence(suffix, result.stdout, result.stderr, result.returncode)

    # 4. Summary
    print("=" * 60)
    if result.returncode == 0:
        print("ALL INTEGRATION TESTS PASSED")
    else:
        print("SOME TESTS FAILED — see evidence file for details")
    print("=" * 60)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
