from __future__ import annotations

import json
import os
import select
import shlex
import shutil
import signal
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
from scripts.remote.tests._fixtures import (
    BUILD_ID,
    CHROME_RELATIVE,
    CHROMIUM_VERSION,
    DEPOT_TOOLS_VERSION,
    EXTENSION_WORKER_RELATIVE,
    MCP_RELATIVE,
    MCP_VERSION,
    SCRIPTCAT_VERSION,
    create_archive,
    create_release,
    release_manifest,
    sha256,
    write_file,
)

OLD_EXTENSION_PAYLOAD = b"old extension\n"
OLD_RUNTIME_PAYLOAD = b"export const release = 'old';\n"
OLD_BUILD_ID = "1" * 24
CHILD_FAILURE_STATUS = 98
CHECKPOINT_READY = b"ready"
CHECKPOINT_TIMEOUT_SECONDS = 10


class ActivationIntegrityTest(unittest.TestCase):
    def test_activation_rejects_unexpected_build_id(self) -> None:
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
                f"f{BUILD_ID[1:]}",
                CHROMIUM_VERSION,
                MCP_VERSION,
                DEPOT_TOOLS_VERSION,
                SCRIPTCAT_VERSION,
            )
            with (
                patch.object(_activation, "PROFILE_LOCK_PATH", lock_path),
                self.assertRaises(_activation.WorkflowError),
            ):
                activate_archive(*arguments, expected_archive_sha256=sha256(archive))
            self.assertFalse(data_root.exists())

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
                self.assertEqual(
                    activate_archive(
                        *arguments, expected_archive_sha256=sha256(archive)
                    ),
                    BUILD_ID,
                )
                self.assertTrue(extension_root.is_symlink())
                self.assertEqual(
                    os.readlink(extension_root),
                    str(data_root / "current" / "scriptcat"),
                )
                extension_inode = extension_root.stat().st_ino
                current_target = os.readlink(data_root / "current")
                self.assertFalse((data_root / "previous").exists())
                self.assertEqual(
                    activate_archive(
                        *arguments, expected_archive_sha256=sha256(archive)
                    ),
                    BUILD_ID,
                )
            self.assertEqual(extension_root.stat().st_ino, extension_inode)
            self.assertEqual(os.readlink(data_root / "current"), current_target)
            self.assertFalse((data_root / "previous").exists())

    def test_rejects_tampered_existing_release_before_version_probe(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(root, source)
            data_root = root / "data"
            extension_root = root / "extensions" / SCRIPTCAT_VERSION
            lock_path = root / "profile.lock"
            marker = root / "version-probe-ran"
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
                activate_archive(
                    *arguments,
                    expected_archive_sha256=sha256(archive),
                )
                existing = Path(os.readlink(data_root / "current"))
                probe = (
                    "#!/bin/sh\n"
                    f": > {shlex.quote(str(marker))}\n"
                    f"printf '%s\\n' 'Chromium {CHROMIUM_VERSION}'\n"
                ).encode()
                rewrite_release_file(
                    existing,
                    CHROME_RELATIVE,
                    probe,
                    executable=True,
                )
                with self.assertRaises(_activation.WorkflowError):
                    activate_archive(
                        *arguments,
                        expected_archive_sha256=sha256(archive),
                    )
            self.assertFalse(marker.exists())

    def test_each_sigkill_stage_keeps_consumer_release_consistent(self) -> None:
        for stage in ActivationStage:
            with self.subTest(stage=stage):
                self.assert_consistent_after_crash(stage)

    def assert_consistent_after_crash(self, crash_stage: ActivationStage) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root / "new")
            manifest = release_manifest(source)
            data_root = root / "data"
            releases = data_root / "releases"
            old_source = create_release(root / "old", build_id=OLD_BUILD_ID)
            rewrite_release_file(
                old_source,
                MCP_RELATIVE,
                OLD_RUNTIME_PAYLOAD,
            )
            rewrite_release_file(
                old_source,
                EXTENSION_WORKER_RELATIVE,
                OLD_EXTENSION_PAYLOAD,
            )
            old_release = releases / OLD_BUILD_ID
            old_release.parent.mkdir(parents=True)
            shutil.copytree(old_source, old_release)
            (data_root / "current").symlink_to(old_release)
            extension_root = root / "extensions" / SCRIPTCAT_VERSION
            shutil.copytree(old_release / "scriptcat", extension_root)
            new_runtime = (source / MCP_RELATIVE).read_bytes()
            new_extension = (source / EXTENSION_WORKER_RELATIVE).read_bytes()
            checkpoint_read, checkpoint_write = os.pipe()
            child = os.fork()
            if child == 0:
                os.close(checkpoint_read)
                try:
                    commit_activation(
                        source,
                        manifest,
                        data_root,
                        extension_root,
                        checkpoint=lambda stage: wait_at_checkpoint(
                            stage,
                            crash_stage,
                            checkpoint_write,
                        ),
                    )
                except BaseException:
                    traceback.print_exc()
                    os._exit(CHILD_FAILURE_STATUS)
                os._exit(CHILD_FAILURE_STATUS)
            os.close(checkpoint_write)
            readable, _, _ = select.select(
                (checkpoint_read,),
                (),
                (),
                CHECKPOINT_TIMEOUT_SECONDS,
            )
            checkpoint_payload = (
                os.read(checkpoint_read, len(CHECKPOINT_READY)) if readable else b""
            )
            os.close(checkpoint_read)
            with suppress(ProcessLookupError):
                os.kill(child, signal.SIGKILL)
            _, wait_status = os.waitpid(child, 0)
            self.assertEqual(checkpoint_payload, CHECKPOINT_READY)
            self.assertEqual(
                os.waitstatus_to_exitcode(wait_status),
                -signal.SIGKILL,
            )
            active_release = Path(os.readlink(data_root / "current"))
            consumer_view = (
                (active_release / MCP_RELATIVE).read_bytes(),
                (
                    extension_root
                    / EXTENSION_WORKER_RELATIVE.removeprefix("scriptcat/")
                ).read_bytes(),
            )
            self.assertIn(
                consumer_view,
                {
                    (OLD_RUNTIME_PAYLOAD, OLD_EXTENSION_PAYLOAD),
                    (new_runtime, new_extension),
                },
            )
            self.assertEqual(
                commit_activation(
                    source,
                    manifest,
                    data_root,
                    extension_root,
                ),
                BUILD_ID,
            )
            self.assertEqual(
                (
                    (
                        Path(os.readlink(data_root / "current")) / MCP_RELATIVE
                    ).read_bytes(),
                    (
                        extension_root
                        / EXTENSION_WORKER_RELATIVE.removeprefix("scriptcat/")
                    ).read_bytes(),
                ),
                (new_runtime, new_extension),
            )


def wait_at_checkpoint(
    stage: ActivationStage,
    target: ActivationStage,
    checkpoint_write: int,
) -> None:
    if stage is target:
        os.write(checkpoint_write, CHECKPOINT_READY)
        signal.pause()


def rewrite_release_file(
    release: Path,
    relative: str,
    payload: bytes,
    *,
    executable: bool = False,
) -> None:
    write_file(release / relative, payload, executable=executable)
    manifest_path = release / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest["files"]
    if not isinstance(files, dict):
        raise AssertionError("release manifest files must be a mapping")
    files[relative] = sha256(release / relative)
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    with (release / "SHA256SUMS").open("wb") as stream:
        for covered in sorted([*files, "manifest.json"]):
            stream.write(
                sha256(release / covered).encode("ascii")
                + b"  "
                + covered.encode("utf-8")
                + b"\0"
            )


if __name__ == "__main__":
    unittest.main()
