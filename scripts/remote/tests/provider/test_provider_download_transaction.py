from __future__ import annotations

import hashlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.remote.provider import _release, package
from scripts.remote.provider._remote import ProviderRemoteConfig


class ProviderDownloadTransactionTest(unittest.TestCase):
    def test_second_publish_failure_rolls_back_and_allows_retry(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary_name:
            root = Path(temporary_name)
            remote_archive = root / "remote.tar.zst"
            remote_archive.write_bytes(b"provider archive")
            remote_digest = root / "remote.tar.zst.sha256"
            remote_digest.write_text(
                f"{hashlib.sha256(remote_archive.read_bytes()).hexdigest()}\n",
                encoding="ascii",
            )
            output = root / "provider.tar.zst"
            sidecar = root / "provider.tar.zst.sha256"
            original_link = os.link

            def copy_remote(command: tuple[str, ...]) -> None:
                source = (
                    remote_digest if command[-2].endswith(".sha256") else remote_archive
                )
                Path(command[-1]).write_bytes(source.read_bytes())

            def fail_sidecar_publish(source: Path, destination: Path) -> None:
                if Path(destination) == sidecar:
                    raise OSError
                original_link(source, destination)

            with (
                patch.object(package, "run_checked", side_effect=copy_remote),
                patch.object(package.os, "link", side_effect=fail_sidecar_publish),
                self.assertRaises(OSError),
            ):
                package._download(
                    ProviderRemoteConfig(), remote_archive.name, output, sidecar
                )

            self.assertFalse(output.exists())
            self.assertFalse(sidecar.exists())

            with patch.object(package, "run_checked", side_effect=copy_remote):
                package._download(
                    ProviderRemoteConfig(), remote_archive.name, output, sidecar
                )

            self.assertEqual(output.read_bytes(), remote_archive.read_bytes())
            self.assertEqual(sidecar.read_bytes(), remote_digest.read_bytes())


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
