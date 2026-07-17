from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.remote._lock import load_lock
from scripts.remote._verified_build import (
    component_build_id,
    verified_build_finalize_script,
)
from scripts.remote.tests._fixtures import MCP_PAYLOAD, MCP_RELATIVE

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


class VerifiedBuildRecoveryTest(unittest.TestCase):
    def test_finalize_replaces_stale_target_component_staging(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            lock = load_lock(REPOSITORY_ROOT / "browser/mcp.lock.json")
            component_id = component_build_id(lock.digest)
            build_root = root / "remote-build"
            runtime = root / "runtime"
            runtime_file = runtime / MCP_RELATIVE
            runtime_file.parent.mkdir(parents=True)
            runtime_file.write_bytes(MCP_PAYLOAD)
            stale = build_root / "builds" / f".{component_id}-new"
            stale.mkdir(parents=True)
            (stale / "partial").write_bytes(b"interrupted build\n")
            script = root / "finalize.sh"
            script.write_text(
                "#!/usr/bin/env bash\n"
                "set -Eeuo pipefail\n"
                "set_phase() { :; }\n"
                f"runtime={runtime!s}\n"
                f"build_root={build_root!s}\n"
                "SOURCE_DATE_EPOCH=1\n"
                f"mcp_build_commit={lock.mcp.commit}\n"
                + verified_build_finalize_script(lock),
                encoding="utf-8",
            )
            subprocess.run(
                ("bash", str(script)),
                check=True,
                cwd=root,
                text=True,
                capture_output=True,
            )
            final = build_root / "builds" / component_id
            self.assertFalse(stale.exists())
            self.assertEqual(
                (final / "runtime" / MCP_RELATIVE).read_bytes(), MCP_PAYLOAD
            )


if __name__ == "__main__":
    unittest.main()
