from __future__ import annotations

import hashlib
import os
import signal
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.remote.provider import _download_transaction, _release, package
from scripts.remote.provider._common import WorkflowError
from scripts.remote.provider._remote import ProviderRemoteConfig

ARCHIVE_BYTES = b"provider archive"
REMOTE_ARCHIVE_NAME = "remote.tar.zst"
OUTPUT_ARCHIVE_NAME = "provider.tar.zst"
SIDECAR_SUFFIX = ".sha256"


def _remote_pair(root: Path) -> tuple[Path, Path]:
    archive = root / REMOTE_ARCHIVE_NAME
    archive.write_bytes(ARCHIVE_BYTES)
    sidecar = root / f"{REMOTE_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
    sidecar.write_text(
        f"{hashlib.sha256(ARCHIVE_BYTES).hexdigest()}\n",
        encoding="ascii",
    )
    return archive, sidecar


def _copy_remote(
    remote_archive: Path, remote_sidecar: Path, command: tuple[str, ...]
) -> None:
    source = remote_sidecar if command[-2].endswith(SIDECAR_SUFFIX) else remote_archive
    Path(command[-1]).write_bytes(source.read_bytes())


class ProviderDownloadTransactionTest(unittest.TestCase):
    def test_archive_publish_failure_rolls_back_and_allows_retry(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            remote_archive, remote_digest = _remote_pair(root)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
            original_link = os.link

            def copy_remote(command: tuple[str, ...]) -> None:
                _copy_remote(remote_archive, remote_digest, command)

            def fail_archive_publish(source: Path, destination: Path) -> None:
                if Path(destination) == output:
                    raise OSError
                original_link(source, destination)

            with (
                patch.object(package, "run_checked", side_effect=copy_remote),
                patch.object(package.os, "link", side_effect=fail_archive_publish),
                self.assertRaises(OSError),
            ):
                package._download(
                    ProviderRemoteConfig(), remote_archive.name, output, sidecar
                )

            self.assertFalse(output.exists())
            self.assertFalse(sidecar.exists())
            self.assertEqual(
                set(root.iterdir()),
                {
                    remote_archive,
                    remote_digest,
                    _download_transaction.lock_path(output),
                    _download_transaction.lock_path(sidecar),
                },
            )

            with patch.object(package, "run_checked", side_effect=copy_remote):
                package._download(
                    ProviderRemoteConfig(), remote_archive.name, output, sidecar
                )

            self.assertEqual(output.read_bytes(), remote_archive.read_bytes())
            self.assertEqual(sidecar.read_bytes(), remote_digest.read_bytes())

    def test_sigkill_after_sidecar_commit_recovers_and_retries(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            remote_archive, remote_sidecar = _remote_pair(root)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"

            self._kill_at_directory_fsync(
                remote_archive, remote_sidecar, output, sidecar, call_number=1
            )

            self.assertFalse(output.exists())
            self.assertEqual(sidecar.read_bytes(), remote_sidecar.read_bytes())
            package._ensure_outputs_available(output, sidecar)
            self.assertFalse(sidecar.exists())

            with patch.object(
                package,
                "run_checked",
                side_effect=lambda command: _copy_remote(
                    remote_archive, remote_sidecar, command
                ),
            ):
                package._download(
                    ProviderRemoteConfig(), remote_archive.name, output, sidecar
                )

            self.assertEqual(output.read_bytes(), remote_archive.read_bytes())
            self.assertEqual(sidecar.read_bytes(), remote_sidecar.read_bytes())

    def test_archive_without_completion_marker_is_safely_rolled_back(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            remote_archive, remote_sidecar = _remote_pair(root)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"

            self._kill_at_directory_fsync(
                remote_archive, remote_sidecar, output, sidecar, call_number=2
            )

            self.assertEqual(output.read_bytes(), remote_archive.read_bytes())
            self.assertEqual(sidecar.read_bytes(), remote_sidecar.read_bytes())
            package._ensure_outputs_available(output, sidecar)
            self.assertFalse(output.exists())
            self.assertFalse(sidecar.exists())

    def test_archive_only_output_is_refused_and_preserved(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
            output.write_bytes(ARCHIVE_BYTES)

            with self.assertRaises(WorkflowError):
                package._ensure_outputs_available(output, sidecar)

            self.assertEqual(output.read_bytes(), ARCHIVE_BYTES)
            self.assertFalse(sidecar.exists())

    def test_foreign_sidecar_only_output_is_refused_and_preserved(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
            sidecar.write_bytes(ARCHIVE_BYTES)

            with self.assertRaises(WorkflowError):
                package._ensure_outputs_available(output, sidecar)

            self.assertEqual(sidecar.read_bytes(), ARCHIVE_BYTES)
            self.assertFalse(output.exists())

    def test_foreign_archive_part_is_refused_and_preserved(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
            foreign = root / f".{OUTPUT_ARCHIVE_NAME}.{'0' * 32}.part"
            foreign.write_bytes(ARCHIVE_BYTES)

            with self.assertRaises(WorkflowError):
                package._ensure_outputs_available(output, sidecar)

            self.assertEqual(foreign.read_bytes(), ARCHIVE_BYTES)
            self.assertFalse(output.exists())
            self.assertFalse(sidecar.exists())

    def test_foreign_journal_is_refused_and_preserved(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            output = root / OUTPUT_ARCHIVE_NAME
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
            journal = _download_transaction.journal_path(output)
            journal.write_bytes(ARCHIVE_BYTES)

            with self.assertRaises(WorkflowError):
                package._ensure_outputs_available(output, sidecar)

            self.assertEqual(journal.read_bytes(), ARCHIVE_BYTES)
            self.assertFalse(output.exists())
            self.assertFalse(sidecar.exists())

    def test_concurrent_downloads_do_not_remove_each_others_paths(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            remote_archive, remote_sidecar = _remote_pair(root)
            output = root / OUTPUT_ARCHIVE_NAME
            competing_output = root / "provider-competing.tar.zst"
            sidecar = root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"
            first_copy_started = threading.Event()
            release_first_copy = threading.Event()
            second_started = threading.Event()
            results: list[BaseException | None] = []
            copy_calls = 0
            copy_calls_lock = threading.Lock()

            def copy_remote(command: tuple[str, ...]) -> None:
                nonlocal copy_calls
                with copy_calls_lock:
                    copy_calls += 1
                    call_number = copy_calls
                if call_number == 1:
                    first_copy_started.set()
                    self.assertTrue(release_first_copy.wait(timeout=5))
                _copy_remote(remote_archive, remote_sidecar, command)

            def download(target: Path, started: threading.Event | None = None) -> None:
                if started is not None:
                    started.set()
                try:
                    package._download(
                        ProviderRemoteConfig(), remote_archive.name, target, sidecar
                    )
                except BaseException as error:
                    results.append(error)
                else:
                    results.append(None)

            with patch.object(package, "run_checked", side_effect=copy_remote):
                first = threading.Thread(target=download, args=(output,))
                second = threading.Thread(
                    target=download, args=(competing_output, second_started)
                )
                first.start()
                self.assertTrue(first_copy_started.wait(timeout=5))
                second.start()
                self.assertTrue(second_started.wait(timeout=5))
                self.assertTrue(second.is_alive())
                release_first_copy.set()
                first.join(timeout=5)
                second.join(timeout=5)

            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(sum(result is None for result in results), 1)
            failures = [result for result in results if result is not None]
            self.assertEqual(len(failures), 1)
            self.assertIsInstance(failures[0], WorkflowError)
            self.assertEqual(output.read_bytes(), remote_archive.read_bytes())
            self.assertFalse(competing_output.exists())
            self.assertEqual(sidecar.read_bytes(), remote_sidecar.read_bytes())
            self.assertEqual(list(root.glob(f".{OUTPUT_ARCHIVE_NAME}.*.part")), [])
            self.assertEqual(list(root.glob(f".{competing_output.name}.*.part")), [])
            self.assertFalse(
                _download_transaction.journal_path(output).exists()
                or _download_transaction.journal_path(output).is_symlink()
            )
            self.assertFalse(
                _download_transaction.journal_path(competing_output).exists()
                or _download_transaction.journal_path(competing_output).is_symlink()
            )

    def test_archive_and_sidecar_may_be_on_different_filesystems(self) -> None:
        shared_memory = Path("/dev/shm")
        if not shared_memory.is_dir():
            self.skipTest("shared memory filesystem is unavailable")
        with (
            tempfile.TemporaryDirectory(dir="/tmp") as archive_name,
            tempfile.TemporaryDirectory(dir=shared_memory) as sidecar_name,
        ):
            archive_root = Path(archive_name)
            sidecar_root = Path(sidecar_name)
            if archive_root.stat().st_dev == sidecar_root.stat().st_dev:
                self.skipTest("test directories use the same filesystem")
            remote_archive, remote_sidecar = _remote_pair(archive_root)
            output = archive_root / OUTPUT_ARCHIVE_NAME
            sidecar = sidecar_root / f"{OUTPUT_ARCHIVE_NAME}{SIDECAR_SUFFIX}"

            with patch.object(
                package,
                "run_checked",
                side_effect=lambda command: _copy_remote(
                    remote_archive, remote_sidecar, command
                ),
            ):
                package._download(
                    ProviderRemoteConfig(), remote_archive.name, output, sidecar
                )

            self.assertEqual(output.read_bytes(), remote_archive.read_bytes())
            self.assertEqual(sidecar.read_bytes(), remote_sidecar.read_bytes())

    def _kill_at_directory_fsync(
        self,
        remote_archive: Path,
        remote_sidecar: Path,
        output: Path,
        sidecar: Path,
        *,
        call_number: int,
    ) -> None:
        process_id = os.fork()
        if process_id == 0:
            original_fsync_directory = package._fsync_directory
            calls = 0

            def kill_after_fsync(path: Path) -> None:
                nonlocal calls
                original_fsync_directory(path)
                calls += 1
                if calls == call_number:
                    os.kill(os.getpid(), signal.SIGKILL)

            try:
                with (
                    patch.object(
                        package,
                        "run_checked",
                        side_effect=lambda command: _copy_remote(
                            remote_archive, remote_sidecar, command
                        ),
                    ),
                    patch.object(
                        package, "_fsync_directory", side_effect=kill_after_fsync
                    ),
                ):
                    package._download(
                        ProviderRemoteConfig(), remote_archive.name, output, sidecar
                    )
            finally:
                os._exit(1)

        _, status = os.waitpid(process_id, 0)
        self.assertTrue(os.WIFSIGNALED(status))
        self.assertEqual(os.WTERMSIG(status), signal.SIGKILL)


class ProviderActivationRecoveryTest(unittest.TestCase):
    def test_recovery_discards_unpublished_journal_and_allows_retry(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            data_root = Path(temporary_name) / "data"
            data_root.mkdir()
            payload = {"schema": 1, "current": None, "previous": None}
            original_replace = os.replace

            def fail_journal_publish(source: Path, destination: Path) -> None:
                if Path(destination) == data_root / "activation-journal.json":
                    raise OSError
                original_replace(source, destination)

            with (
                patch.object(_release.os, "replace", side_effect=fail_journal_publish),
                self.assertRaises(OSError),
            ):
                _release.write_journal(data_root, payload)

            temporary = data_root / ".activation-journal.new"
            self.assertTrue(temporary.is_file())
            _release.recover_interrupted_activation(data_root)
            self.assertFalse(temporary.exists())

            _release.write_journal(data_root, payload)
            self.assertTrue((data_root / "activation-journal.json").is_file())

    def test_recovery_removes_interrupted_current_link_then_restores_journal(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            data_root = Path(temporary_name) / "data"
            releases = data_root / "releases"
            old = releases / "old"
            older = releases / "older"
            new = releases / "new"
            for release in (old, older, new):
                release.mkdir(parents=True, exist_ok=True)
            current = data_root / "current"
            previous = data_root / "previous"
            current.symlink_to(old)
            previous.symlink_to(older)
            _release.write_journal(
                data_root,
                {"schema": 1, "current": str(old), "previous": str(older)},
            )
            _release.replace_link(previous, old)
            original_replace = os.replace

            def fail_current_publish(source: Path, destination: Path) -> None:
                if Path(destination) == current:
                    raise OSError
                original_replace(source, destination)

            with (
                patch.object(_release.os, "replace", side_effect=fail_current_publish),
                self.assertRaises(OSError),
            ):
                _release.replace_link(current, new)

            self.assertTrue((data_root / ".current.new").is_symlink())
            _release.recover_interrupted_activation(data_root)
            _release.recover_interrupted_activation(data_root)

            self.assertFalse((data_root / ".current.new").exists())
            self.assertEqual(os.readlink(current), str(old))
            self.assertEqual(os.readlink(previous), str(older))
            self.assertFalse((data_root / "activation-journal.json").exists())


if __name__ == "__main__":
    unittest.main()
