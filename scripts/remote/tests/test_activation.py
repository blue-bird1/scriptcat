from __future__ import annotations

import fcntl
import os
import select
import shutil
import signal
import tempfile
import traceback
import unittest
from contextlib import suppress
from pathlib import Path

from scripts.remote._activation import (
    ACTIVATION_LOCK_NAME,
    ActivationStage,
    activate_archive,
    commit_activation,
)
from scripts.remote._activation_state import recover_activation
from scripts.remote._common import WorkflowError
from scripts.remote.tests._fixtures import (
    BUILD_ID,
    MCP_RELATIVE,
    MCP_VERSION,
    create_archive,
    create_release,
    release_manifest,
    rewrite_release_file,
    sha256,
)

OLD_BUILD_ID = "1" * 24
OLDER_BUILD_ID = "2" * 24
CHECKPOINT_READY = b"ready"


class ActivationIntegrityTest(unittest.TestCase):
    def test_activation_fails_when_transaction_is_already_running(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            data_root = root / "data"
            data_root.mkdir()
            with (data_root / ACTIVATION_LOCK_NAME).open(
                "a+", encoding="utf-8"
            ) as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaises(WorkflowError):
                    activate_archive(
                        archive,
                        data_root,
                        BUILD_ID,
                        MCP_VERSION,
                        expected_archive_sha256=sha256(archive),
                    )

    def test_repeated_activation_is_idempotent_and_ignores_managed_extension_root(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            data_root = root / "data"
            managed = root / ".codex" / "chrome-extensions" / "scriptcat" / "sentinel"
            managed.parent.mkdir(parents=True)
            managed.write_bytes(b"managed extension remains external\n")
            first = activate_archive(
                archive,
                data_root,
                BUILD_ID,
                MCP_VERSION,
                expected_archive_sha256=sha256(archive),
            )
            first_target = os.readlink(data_root / "current")
            second = activate_archive(
                archive,
                data_root,
                BUILD_ID,
                MCP_VERSION,
                expected_archive_sha256=sha256(archive),
            )
            self.assertEqual((first, second), (BUILD_ID, BUILD_ID))
            self.assertEqual(os.readlink(data_root / "current"), first_target)
            self.assertFalse((data_root / "previous").exists())
            self.assertEqual(
                managed.read_bytes(), b"managed extension remains external\n"
            )

    def test_activation_rejects_unexpected_build_id(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            with self.assertRaises(WorkflowError):
                activate_archive(
                    archive,
                    root / "data",
                    "f" * 24,
                    MCP_VERSION,
                    expected_archive_sha256=sha256(archive),
                )

    def test_activation_replaces_stale_target_release_staging(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            data_root = root / "data"
            stale = data_root / "releases" / f".{BUILD_ID}-new"
            stale.mkdir(parents=True)
            (stale / "partial").write_bytes(b"interrupted activation\n")
            activated = activate_archive(
                archive,
                data_root,
                BUILD_ID,
                MCP_VERSION,
                expected_archive_sha256=sha256(archive),
            )
            self.assertEqual(activated, BUILD_ID)
            self.assertFalse(stale.exists())
            self.assertEqual(
                os.readlink(data_root / "current"),
                str(data_root / "releases" / BUILD_ID),
            )

    def test_interrupted_activation_recovers_prior_links_then_retries(self) -> None:
        for stage in ActivationStage:
            with self.subTest(stage=stage):
                self._assert_recovery(stage)

    def _assert_recovery(self, crash_stage: ActivationStage) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            new_source = create_release(root / "new")
            new_manifest = release_manifest(new_source)
            old_source = create_release(root / "old", build_id=OLD_BUILD_ID)
            rewrite_release_file(
                old_source, MCP_RELATIVE, b"export const release = 'old';\n"
            )
            older_source = create_release(root / "older", build_id=OLDER_BUILD_ID)
            rewrite_release_file(
                older_source, MCP_RELATIVE, b"export const release = 'older';\n"
            )
            data_root = root / "data"
            old_release = data_root / "releases" / OLD_BUILD_ID
            older_release = data_root / "releases" / OLDER_BUILD_ID
            old_release.parent.mkdir(parents=True)
            shutil.copytree(old_source, old_release)
            shutil.copytree(older_source, older_release)
            (data_root / "current").symlink_to(old_release)
            (data_root / "previous").symlink_to(older_release)
            checkpoint_read, checkpoint_write = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(checkpoint_read)
                try:
                    commit_activation(
                        new_source,
                        new_manifest,
                        data_root,
                        checkpoint=lambda stage: self._wait_at_checkpoint(
                            stage, crash_stage, checkpoint_write
                        ),
                    )
                except BaseException:
                    traceback.print_exc()
                os._exit(98)
            os.close(checkpoint_write)
            readable, _, _ = select.select((checkpoint_read,), (), (), 10)
            payload = (
                os.read(checkpoint_read, len(CHECKPOINT_READY)) if readable else b""
            )
            os.close(checkpoint_read)
            with suppress(ProcessLookupError):
                os.kill(child, signal.SIGKILL)
            os.waitpid(child, 0)
            self.assertEqual(payload, CHECKPOINT_READY)
            recover_activation(data_root)
            expected_current = (
                data_root / "releases" / BUILD_ID
                if crash_stage is ActivationStage.CLEANUP_FINISHED
                else old_release
            )
            expected_previous = (
                old_release
                if crash_stage is ActivationStage.CLEANUP_FINISHED
                else older_release
            )
            self.assertEqual(os.readlink(data_root / "current"), str(expected_current))
            self.assertEqual(
                os.readlink(data_root / "previous"), str(expected_previous)
            )
            self.assertEqual(
                commit_activation(new_source, new_manifest, data_root), BUILD_ID
            )
            self.assertEqual(
                os.readlink(data_root / "current"),
                str(data_root / "releases" / BUILD_ID),
            )
            self.assertEqual(os.readlink(data_root / "previous"), str(old_release))

    @staticmethod
    def _wait_at_checkpoint(
        stage: ActivationStage, target: ActivationStage, descriptor: int
    ) -> None:
        if stage is target:
            os.write(descriptor, CHECKPOINT_READY)
            signal.pause()


if __name__ == "__main__":
    unittest.main()
