from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.mcp import _package_transaction, package
from scripts.mcp._archive import read_manifest
from scripts.mcp._common import WorkflowError
from scripts.mcp._component import materialize_component
from scripts.mcp._identity import component_build_id
from scripts.mcp._lock import load_lock

MCP_EXECUTABLE = Path("mcp/bin/chrome-devtools-mcp.js")
SOURCE = "https://github.com/blue-bird1/chrome-devtools-mcp.git"
UPSTREAM_SOURCE = "https://github.com/ChromeDevTools/chrome-devtools-mcp.git"
BUILD_COMMIT = "2" * 40
UPSTREAM_COMMIT = "1" * 40
PAYLOAD = b"transactional MCP package"


class McpPackageTransactionTest(unittest.TestCase):
    def test_output_directory_sync_failure_rolls_back_pair_and_allows_retry(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            original_sync = _package_transaction.fsync_directory
            calls = 0

            def fail_first_sync(path: Path) -> None:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("injected output directory sync failure")
                original_sync(path)

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                patch.object(
                    _package_transaction,
                    "fsync_directory",
                    side_effect=fail_first_sync,
                ),
                redirect_stdout(StringIO()),
                self.assertRaises(WorkflowError),
            ):
                package.run(fixture.arguments)

            self.assertEqual(list(fixture.archive.parent.iterdir()), [])
            self.assertEqual(list(fixture.digest.parent.iterdir()), [])

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
            ):
                package.run(fixture.arguments)

            assert_complete_pair(self, fixture)

    def test_first_publish_failure_rolls_back_pair_and_allows_retry(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            original_link = os.link

            def fail_digest_publish(source: Path, destination: Path) -> None:
                if Path(destination) == fixture.digest:
                    raise OSError("injected digest publish failure")
                original_link(source, destination)

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                patch.object(
                    _package_transaction.os,
                    "link",
                    side_effect=fail_digest_publish,
                ),
                redirect_stdout(StringIO()),
                self.assertRaises(WorkflowError),
            ):
                package.run(fixture.arguments)

            self.assertEqual(list(fixture.archive.parent.iterdir()), [])
            self.assertEqual(list(fixture.digest.parent.iterdir()), [])

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
            ):
                package.run(fixture.arguments)

            assert_complete_pair(self, fixture)

    def test_sigkill_between_outputs_is_recovered_by_retry(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            child = f"""
import os
import signal
from scripts.mcp import _package_transaction, package

original_link = _package_transaction.os.link
calls = 0

def kill_after_first_publish(source, destination):
    global calls
    original_link(source, destination)
    calls += 1
    if calls == 1:
        os.kill(os.getpid(), signal.SIGKILL)

_package_transaction.os.link = kill_after_first_publish
package.run({fixture.arguments!r})
"""
            completed = subprocess.run(
                [sys.executable, "-c", child],
                cwd=Path(__file__).resolve().parents[3],
                check=False,
            )

            self.assertEqual(completed.returncode, -signal.SIGKILL)
            self.assertFalse(fixture.archive.exists())
            self.assertTrue(fixture.digest.is_file())

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
            ):
                package.run(fixture.arguments)

            assert_complete_pair(self, fixture)

    def test_sigkill_during_initial_journal_publish_is_recoverable(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            child = f"""
import os
import signal
from pathlib import Path
from scripts.mcp import _package_journal, package

original_replace = _package_journal.os.replace

def kill_before_journal_replace(source, destination):
    if Path(destination).name == _package_journal.JOURNAL_NAME:
        os.kill(os.getpid(), signal.SIGKILL)
    original_replace(source, destination)

_package_journal.os.replace = kill_before_journal_replace
package.run({fixture.arguments!r})
"""
            completed = subprocess.run(
                [sys.executable, "-c", child],
                cwd=Path(__file__).resolve().parents[3],
                check=False,
            )

            journal = fixture.build_root / _package_transaction.JOURNAL_NAME
            self.assertEqual(completed.returncode, -signal.SIGKILL)
            self.assertFalse(journal.exists())
            self.assertTrue(Path(f"{journal}.new").is_symlink())

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
            ):
                package.run(fixture.arguments)

            assert_complete_pair(self, fixture)

    def test_sigkill_after_stage_intent_before_create_is_recoverable(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            child = f"""
import os
import signal
from pathlib import Path
from scripts.mcp import _package_transaction, package

original_open = _package_transaction.os.open

def kill_before_stage_create(path, flags, mode=0o777):
    candidate = Path(path)
    if candidate.name.endswith(".part") and flags & os.O_EXCL:
        os.kill(os.getpid(), signal.SIGKILL)
    return original_open(path, flags, mode)

_package_transaction.os.open = kill_before_stage_create
package.run({fixture.arguments!r})
"""
            completed = subprocess.run(
                [sys.executable, "-c", child],
                cwd=Path(__file__).resolve().parents[3],
                check=False,
            )

            self.assertEqual(completed.returncode, -signal.SIGKILL)
            self.assertEqual(list(fixture.archive.parent.iterdir()), [])
            self.assertEqual(list(fixture.digest.parent.iterdir()), [])

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
            ):
                package.run(fixture.arguments)

            assert_complete_pair(self, fixture)

    def test_sigkill_after_stage_create_before_identity_preserves_unknown_file(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            child = f"""
import os
import signal
from scripts.mcp import _package_transaction, package

original_persist = _package_transaction.persist_journal
calls = 0

def kill_before_identity_update(path, journal):
    global calls
    calls += 1
    if calls == 3:
        os.kill(os.getpid(), signal.SIGKILL)
    original_persist(path, journal)

_package_transaction.persist_journal = kill_before_identity_update
package.run({fixture.arguments!r})
"""
            completed = subprocess.run(
                [sys.executable, "-c", child],
                cwd=Path(__file__).resolve().parents[3],
                check=False,
            )

            self.assertEqual(completed.returncode, -signal.SIGKILL)
            staged = list(fixture.archive.parent.glob("*.part"))
            self.assertEqual(len(staged), 1)
            self.assertEqual(staged[0].stat().st_size, 0)

            unknown = staged[0]
            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
                self.assertRaises(WorkflowError),
            ):
                package.run(fixture.arguments)

            self.assertTrue(unknown.is_file())
            self.assertEqual(unknown.stat().st_size, 0)
            self.assertFalse(fixture.archive.exists())
            self.assertFalse(fixture.digest.exists())

    def test_foreign_empty_file_at_unidentified_intent_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            child = f"""
import os
import signal
from pathlib import Path
from scripts.mcp import _package_transaction, package

original_open = _package_transaction.os.open

def kill_before_stage_create(path, flags, mode=0o777):
    candidate = Path(path)
    if candidate.name.endswith(".part") and flags & os.O_EXCL:
        os.kill(os.getpid(), signal.SIGKILL)
    return original_open(path, flags, mode)

_package_transaction.os.open = kill_before_stage_create
package.run({fixture.arguments!r})
"""
            completed = subprocess.run(
                [sys.executable, "-c", child],
                cwd=Path(__file__).resolve().parents[3],
                check=False,
            )
            self.assertEqual(completed.returncode, -signal.SIGKILL)

            journal_path = fixture.build_root / _package_transaction.JOURNAL_NAME
            journal = _package_transaction.read_journal(journal_path)
            self.assertEqual(len(journal.staged), 1)
            foreign = journal.staged[0].path
            foreign.touch()

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
                self.assertRaises(WorkflowError),
            ):
                package.run(fixture.arguments)

            self.assertTrue(foreign.is_file())
            self.assertEqual(foreign.stat().st_size, 0)
            self.assertTrue(journal_path.is_symlink())

    def test_sigkill_before_publish_recovers_all_staged_parts(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            child = f"""
import os
import signal
from scripts.mcp import package

def kill_at_publish(_path, journal, _archive, _digest):
    for staged in journal.staged:
        actual = staged.path.stat()
        if (actual.st_dev, actual.st_ino) != (staged.device, staged.inode):
            raise RuntimeError("production tool replaced a journaled staging inode")
    os.kill(os.getpid(), signal.SIGKILL)

package.publish_package_outputs = kill_at_publish
package.run({fixture.arguments!r})
"""
            completed = subprocess.run(
                [sys.executable, "-c", child],
                cwd=Path(__file__).resolve().parents[3],
                check=False,
            )

            self.assertEqual(completed.returncode, -signal.SIGKILL)
            self.assertTrue(any(fixture.archive.parent.glob("*.part")))
            self.assertTrue(any(fixture.digest.parent.glob("*.part")))

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
            ):
                package.run(fixture.arguments)

            assert_complete_pair(self, fixture)

    def test_foreign_journal_staging_file_is_preserved_and_rejected(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            foreign = fixture.build_root / (_package_transaction.JOURNAL_NAME + ".new")
            payload = b"foreign journal staging content\n"
            foreign.write_bytes(payload)

            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(StringIO()),
                self.assertRaises(WorkflowError),
            ):
                package.run(fixture.arguments)

            self.assertEqual(foreign.read_bytes(), payload)
            self.assertEqual(list(fixture.archive.parent.iterdir()), [])
            self.assertEqual(list(fixture.digest.parent.iterdir()), [])

    def test_stdout_contains_only_release_id(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            fixture = create_fixture(Path(name))
            stdout = StringIO()
            with (
                patch.object(package, "repository_root", return_value=fixture.root),
                redirect_stdout(stdout),
            ):
                package.run(fixture.arguments)

            releases = list((fixture.build_root / "releases").iterdir())
            self.assertEqual(len(releases), 1)
            release_id = read_manifest(releases[0]).build_id
            self.assertEqual(stdout.getvalue(), release_id + "\n")


@dataclass(frozen=True)
class PackageFixture:
    root: Path
    build_root: Path
    archive: Path
    digest: Path
    arguments: tuple[str, ...]


def create_fixture(root: Path) -> PackageFixture:
    build_root = root / "build"
    lock_path = root / "mcp.lock.json"
    write_lock(lock_path)
    lock = load_lock(lock_path)
    runtime = root / "runtime"
    executable = runtime / MCP_EXECUTABLE
    executable.parent.mkdir(parents=True)
    executable.write_bytes(PAYLOAD)
    materialize_component(runtime, build_root / "builds", lock, 1)
    build_id = component_build_id(lock.digest)
    archive_parent = root / "archive"
    digest_parent = root / "digest"
    archive_parent.mkdir()
    digest_parent.mkdir()
    archive = archive_parent / "mcp.tar.zst"
    digest = digest_parent / "mcp.sha256"
    return PackageFixture(
        root=root,
        build_root=build_root,
        archive=archive,
        digest=digest,
        arguments=(
            "--build-id",
            build_id,
            "--lock",
            str(lock_path),
            "--build-root",
            str(build_root),
            "--output",
            str(archive),
            "--sha256-output",
            str(digest),
        ),
    )


def assert_complete_pair(test: unittest.TestCase, fixture: PackageFixture) -> None:
    expected_digest = hashlib.sha256(fixture.archive.read_bytes()).hexdigest()
    test.assertEqual(fixture.digest.read_text(encoding="ascii"), expected_digest + "\n")
    test.assertEqual(list(fixture.archive.parent.iterdir()), [fixture.archive])
    test.assertEqual(list(fixture.digest.parent.iterdir()), [fixture.digest])


def write_lock(path: Path) -> None:
    payload = {
        "schema_version": 2,
        "chrome_devtools_mcp": {
            "version": "1.5.0",
            "commit": BUILD_COMMIT,
            "source": SOURCE,
            "upstream_source": UPSTREAM_SOURCE,
            "upstream_commit": UPSTREAM_COMMIT,
        },
    }
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
