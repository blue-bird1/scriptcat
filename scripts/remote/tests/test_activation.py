from __future__ import annotations

import os
import tempfile
import traceback
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.remote import _activation
from scripts.remote._activation import (
    activate_archive,
    commit_activation,
    prepare_extension,
)
from scripts.remote._activation_state import ActivationStage, recover_activation
from scripts.remote.tests._fixtures import (
    BUILD_ID,
    CHROMIUM_VERSION,
    DEPOT_TOOLS_VERSION,
    EXTENSION_WORKER_RELATIVE,
    MCP_VERSION,
    SCRIPTCAT_VERSION,
    create_archive,
    create_release,
    release_manifest,
    write_file,
)

OLD_EXTENSION_PAYLOAD = b"old extension\n"
NEW_EXTENSION_PAYLOAD = b"const managed = true;\n"
OLD_BUILD_ID = "old-build"
OLDER_BUILD_ID = "older-build"
CRASH_EXIT_STATUS = 91
CHILD_FAILURE_STATUS = 98


class ActivationIntegrityTest(unittest.TestCase):
    def test_repeated_activation_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            data_root = root / "data"
            extension_root = root / "extensions" / SCRIPTCAT_VERSION
            lock_path = root / "profile.lock"
            arguments = (
                archive,
                data_root,
                extension_root,
                BUILD_ID,
                CHROMIUM_VERSION,
                MCP_VERSION,
                DEPOT_TOOLS_VERSION,
                SCRIPTCAT_VERSION,
            )
            with patch.object(_activation, "PROFILE_LOCK_PATH", lock_path):
                self.assertEqual(activate_archive(*arguments), BUILD_ID)
                extension_inode = extension_root.stat().st_ino
                current_target = os.readlink(data_root / "current")
                self.assertFalse((data_root / "previous").exists())
                self.assertEqual(activate_archive(*arguments), BUILD_ID)
            self.assertEqual(extension_root.stat().st_ino, extension_inode)
            self.assertEqual(os.readlink(data_root / "current"), current_target)
            self.assertFalse((data_root / "previous").exists())

    def test_each_durable_stage_recovers_consistently(self) -> None:
        for stage in ActivationStage:
            with self.subTest(stage=stage):
                self.assert_crash_recovery(stage)

    def assert_crash_recovery(self, crash_stage: ActivationStage) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            manifest = release_manifest(source)
            data_root = root / "data"
            releases = data_root / "releases"
            old_release = releases / OLD_BUILD_ID
            older_release = releases / OLDER_BUILD_ID
            old_release.mkdir(parents=True)
            older_release.mkdir()
            (data_root / "current").symlink_to(old_release)
            (data_root / "previous").symlink_to(older_release)
            extension_root = root / "extensions" / SCRIPTCAT_VERSION
            write_file(
                extension_root / EXTENSION_WORKER_RELATIVE.removeprefix("scriptcat/"),
                OLD_EXTENSION_PAYLOAD,
            )
            extension_temporary = prepare_extension(source, extension_root)
            child = os.fork()
            if child == 0:
                try:
                    commit_activation(
                        source,
                        manifest,
                        data_root,
                        extension_root,
                        extension_temporary,
                        checkpoint=lambda stage: crash_at(stage, crash_stage),
                    )
                except BaseException:
                    traceback.print_exc()
                    os._exit(CHILD_FAILURE_STATUS)
                os._exit(CHILD_FAILURE_STATUS)
            _, wait_status = os.waitpid(child, 0)
            self.assertEqual(os.waitstatus_to_exitcode(wait_status), CRASH_EXIT_STATUS)
            recover_activation(data_root, extension_root)
            committed = crash_stage is ActivationStage.JOURNAL_REMOVED
            expected_current = (
                data_root / "releases" / BUILD_ID if committed else old_release
            )
            expected_previous = old_release if committed else older_release
            expected_extension = (
                NEW_EXTENSION_PAYLOAD if committed else OLD_EXTENSION_PAYLOAD
            )
            self.assertEqual(os.readlink(data_root / "current"), str(expected_current))
            self.assertEqual(
                os.readlink(data_root / "previous"), str(expected_previous)
            )
            installed_worker = extension_root / EXTENSION_WORKER_RELATIVE.removeprefix(
                "scriptcat/"
            )
            self.assertEqual(installed_worker.read_bytes(), expected_extension)


def crash_at(stage: ActivationStage, target: ActivationStage) -> None:
    if stage is target:
        os._exit(CRASH_EXIT_STATUS)


if __name__ == "__main__":
    unittest.main()
