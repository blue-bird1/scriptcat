from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from scripts.remote.provider._lock import load_lock
from scripts.remote.provider._identity import release_build_id
from scripts.remote.provider._remote import ProviderRemoteConfig, remote_package_script

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
LOCK_PATH = REPOSITORY_ROOT / "browser" / "provider.lock.json"
COMPONENT_ID = "0123456789abcdef01234567"
ARCHIVE_NAME = "provider-transaction.tar.zst"


class ProviderRemoteTransactionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory(dir="/tmp")
        self.root = Path(self.temporary_directory.name)
        self.lock = load_lock(LOCK_PATH)
        self.config = ProviderRemoteConfig(
            build_root=str(self.root), checkout=str(self.root / "checkout")
        )
        self.archive = self.root / "out" / ARCHIVE_NAME
        self.digest = self.archive.with_suffix(self.archive.suffix + ".sha256")
        self.release_id = self._create_verified_build()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_retry_recovers_killed_publish_without_a_half_pair(self) -> None:
        commands = self.root / "commands"
        commands.mkdir()
        self._write_executable(
            commands / "mv",
            """#!/usr/bin/env bash
set -Eeuo pipefail
destination="${!#}"
/bin/mv "$@"
if [ "$destination" = "$TARGET_ARCHIVE" ]; then
  kill -KILL "$PPID"
fi
""",
        )

        interrupted = self._run(
            {
                "PATH": f"{commands}:{os.environ['PATH']}",
                "TARGET_ARCHIVE": str(self.archive),
            }
        )

        self.assertNotEqual(interrupted.returncode, 0)
        self.assertTrue(self.archive.is_file())
        self.assertFalse(self.digest.exists())

        recovered = self._run()

        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertTrue(self.archive.is_file())
        self.assertTrue(self.digest.is_file())
        self.assertEqual(
            hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            self.digest.read_text(encoding="utf-8").strip(),
        )
        self.assertEqual(
            list((self.root / "out").glob(f".package-{self.release_id}.*")), []
        )

    def test_package_lock_serializes_concurrent_idempotent_retries(self) -> None:
        commands = self.root / "commands"
        commands.mkdir()
        ready = self.root / "zstd-ready"
        self._write_executable(
            commands / "zstd",
            """#!/usr/bin/env bash
set -Eeuo pipefail
if [ ! -e "$ZSTD_READY" ]; then
  : > "$ZSTD_READY"
  sleep 1
fi
exec /usr/bin/zstd "$@"
""",
        )
        environment = {
            **os.environ,
            "PATH": f"{commands}:{os.environ['PATH']}",
            "ZSTD_READY": str(ready),
        }
        first = self._start(environment)
        self._wait_for(ready)
        second = self._start(environment)

        time.sleep(0.1)
        self.assertIsNone(second.poll())
        first_stdout, first_stderr = first.communicate(timeout=30)
        second_stdout, second_stderr = second.communicate(timeout=30)

        self.assertEqual(first.returncode, 0, first_stderr)
        self.assertEqual(second.returncode, 0, second_stderr)
        self.assertEqual(first_stdout, "")
        self.assertEqual(second_stdout, "")
        self.assertTrue(self.archive.is_file())
        self.assertTrue(self.digest.is_file())

    def _create_verified_build(self) -> str:
        runtime = self.root / "builds" / COMPONENT_ID / "runtime"
        chrome = runtime / "chrome-linux" / "chrome"
        chrome.parent.mkdir(parents=True)
        chrome.write_bytes(b"#!/bin/sh\nexit 0\n")
        chrome.chmod(0o755)
        files = {"chrome-linux/chrome": hashlib.sha256(chrome.read_bytes()).hexdigest()}
        manifest = {
            "schema": 2,
            "build_id": COMPONENT_ID,
            "lock_digest": self.lock.digest,
            "source_date_epoch": 1,
            "versions": {
                "chromium": self.lock.chromium.version,
                "depot_tools": self.lock.depot_tools.version,
            },
            "provenance": {
                "chromium": {
                    "upstream_commit": self.lock.chromium.commit,
                    "patch_digest": self.lock.chromium_patch.sha256,
                    "build_commit": "a" * 40,
                },
                "depot_tools": {
                    "upstream_commit": self.lock.depot_tools.commit,
                    "build_commit": self.lock.depot_tools.commit,
                },
            },
            "files": files,
            "directories": ["chrome-linux"],
        }
        (runtime.parent / "build-manifest.json").write_text(
            json.dumps(manifest, sort_keys=True), encoding="utf-8"
        )
        return release_build_id(COMPONENT_ID, files)

    def _run(
        self, additional_environment: dict[str, str] | None = None
    ) -> subprocess.CompletedProcess[str]:
        environment = {**os.environ, **(additional_environment or {})}
        return subprocess.run(
            ("bash", "-s"),
            check=False,
            text=True,
            input=self._script(),
            capture_output=True,
            env=environment,
        )

    def _start(self, environment: dict[str, str]) -> subprocess.Popen[str]:
        return subprocess.Popen(
            ("bash", "-c", self._script()),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )

    def _script(self) -> str:
        return remote_package_script(
            self.config,
            self.lock,
            COMPONENT_ID,
            self.release_id,
            ARCHIVE_NAME,
        )

    def _wait_for(self, path: Path) -> None:
        deadline = time.monotonic() + 10
        while not path.exists():
            if time.monotonic() >= deadline:
                self.fail(f"timed out waiting for {path}")
            time.sleep(0.01)

    def _write_executable(self, path: Path, content: str) -> None:
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755)


if __name__ == "__main__":
    unittest.main()
