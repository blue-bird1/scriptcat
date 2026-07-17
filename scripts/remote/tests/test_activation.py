from __future__ import annotations

import json
import os
import select
import shutil
import signal
import stat
import tempfile
import traceback
import unittest
from contextlib import suppress
from pathlib import Path
from unittest.mock import patch

from scripts.remote import _activation
from scripts.remote._activation import (
    ActivationStage,
    activate_archive,
    commit_activation,
)
from scripts.remote._activation_state import recover_activation
from scripts.remote._common import WorkflowError
from scripts.remote.tests._fixtures import (
    BUILD_ID,
    EXTENSION_WORKER_RELATIVE,
    MCP_RELATIVE,
    MCP_VERSION,
    SCRIPTCAT_VERSION,
    create_archive,
    create_release,
    release_manifest,
    rewrite_release_file,
    sha256,
)

OLD_BUILD_ID = "1" * 24
CHECKPOINT_READY = b"ready"


class ActivationIntegrityTest(unittest.TestCase):
    def test_repeated_activation_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            data_root = root / "data"
            extension_root = root / "extensions" / SCRIPTCAT_VERSION
            arguments = (
                archive,
                data_root,
                extension_root,
                BUILD_ID,
                MCP_VERSION,
                SCRIPTCAT_VERSION,
            )
            with patch.object(_activation, "PROFILE_LOCK_PATH", root / "profile.lock"):
                first = activate_archive(
                    *arguments, expected_archive_sha256=sha256(archive)
                )
                first_target = os.readlink(data_root / "current")
                second = activate_archive(
                    *arguments, expected_archive_sha256=sha256(archive)
                )
            self.assertEqual((first, second), (BUILD_ID, BUILD_ID))
            self.assertEqual(os.readlink(data_root / "current"), first_target)
            self.assertFalse((data_root / "previous").exists())
            self.assertTrue(extension_root.is_dir())
            self.assertFalse(extension_root.is_symlink())

    def test_activation_rejects_unexpected_build_id(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            with (
                patch.object(_activation, "PROFILE_LOCK_PATH", root / "profile.lock"),
                self.assertRaises(WorkflowError),
            ):
                activate_archive(
                    archive,
                    root / "data",
                    root / "extension",
                    "f" * 24,
                    MCP_VERSION,
                    SCRIPTCAT_VERSION,
                    expected_archive_sha256=sha256(archive),
                )

    def test_legacy_current_browser_tree_is_never_read_or_modified(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root / "new")
            manifest = release_manifest(source)
            data_root = root / "data"
            releases = data_root / "releases"
            releases.mkdir(parents=True)
            legacy = releases / OLD_BUILD_ID
            legacy_extension = legacy / "scriptcat"
            shutil.copytree(source / "scriptcat", legacy_extension)
            browser_tree = legacy / "chromium"
            browser_file = browser_tree / "chrome-linux" / "chrome"
            browser_file.parent.mkdir(parents=True)
            browser_file.write_bytes(b"legacy browser bytes\n")
            browser_file.chmod(0o600)
            browser_stat = browser_file.stat()
            legacy_manifest = json.loads(
                (source / "manifest.json").read_text(encoding="utf-8")
            )
            legacy_manifest.pop("schema")
            legacy_manifest.pop("component_build_id")
            legacy_manifest.pop("project_commit", None)
            legacy_manifest.pop("lock_digest")
            versions = legacy_manifest.pop("versions")
            legacy_manifest["mcp_version"] = versions["chrome_devtools_mcp"]
            legacy_manifest["scriptcat_version"] = versions["scriptcat"]
            legacy_manifest["files"]["chromium/chrome-linux/chrome"] = "f" * 64
            legacy_manifest["directories"].extend(["chromium", "chromium/chrome-linux"])
            legacy_manifest["directories"].sort()
            (legacy / "manifest.json").write_text(
                json.dumps(legacy_manifest, sort_keys=True), encoding="utf-8"
            )
            (data_root / "current").symlink_to(legacy)
            extension_root = root / "extension"
            shutil.copytree(legacy_extension, extension_root)
            browser_tree.chmod(0)
            try:
                activated = commit_activation(
                    source, manifest, data_root, extension_root
                )
                self.assertEqual(activated, BUILD_ID)
                self.assertEqual(os.readlink(data_root / "previous"), str(legacy))
                self.assertEqual(
                    os.readlink(data_root / "current"),
                    str(releases / BUILD_ID),
                )
                self.assertEqual(stat.S_IMODE(browser_tree.stat().st_mode), 0)
            finally:
                browser_tree.chmod(0o755)
            self.assertEqual(browser_file.stat(), browser_stat)
            self.assertEqual(browser_file.read_bytes(), b"legacy browser bytes\n")

    def test_each_interrupted_stage_recovers_transaction(self) -> None:
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
            rewrite_release_file(
                old_source, EXTENSION_WORKER_RELATIVE, b"old extension\n"
            )
            data_root = root / "data"
            old_release = data_root / "releases" / OLD_BUILD_ID
            old_release.parent.mkdir(parents=True)
            shutil.copytree(old_source, old_release)
            (data_root / "current").symlink_to(old_release)
            extension_root = root / "extension"
            shutil.copytree(old_release / "scriptcat", extension_root)
            checkpoint_read, checkpoint_write = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(checkpoint_read)
                try:
                    commit_activation(
                        new_source,
                        new_manifest,
                        data_root,
                        extension_root,
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
            recover_activation(data_root, extension_root)
            if crash_stage is ActivationStage.CLEANUP_FINISHED:
                expected_current = data_root / "releases" / BUILD_ID
            else:
                expected_current = old_release
            self.assertEqual(os.readlink(data_root / "current"), str(expected_current))
            self.assertEqual(
                commit_activation(new_source, new_manifest, data_root, extension_root),
                BUILD_ID,
            )

    @staticmethod
    def _wait_at_checkpoint(
        stage: ActivationStage, target: ActivationStage, descriptor: int
    ) -> None:
        if stage is target:
            os.write(descriptor, CHECKPOINT_READY)
            signal.pause()


if __name__ == "__main__":
    unittest.main()
