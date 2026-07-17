from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.mcp import install
from scripts.mcp._common import WorkflowError
from scripts.mcp.tests._fixtures import (
    ReleaseFixture,
    clone_release,
    create_archive,
    create_release_fixture,
    file_sha256,
    link_targets,
    write_manifest_and_checksums,
)


class InstallRejectionTest(unittest.TestCase):
    def test_install_rejects_build_id_not_derived_from_runtime_inventory(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            installed = create_release_fixture(root / "installed", payload=b"old\n")
            tampered = create_release_fixture(root / "tampered", payload=b"new\n")
            data_root = root / "data"
            install_fixture(root, data_root, installed)
            before = link_targets(data_root)
            archive = rewrite_build_id(root, tampered, "f" * 24)

            with self.assertRaises(WorkflowError):
                run_install(root, data_root, tampered, archive, "f" * 24)

            self.assertEqual(link_targets(data_root), before)
            self.assertEqual(
                sorted(path.name for path in (data_root / "releases").iterdir()),
                [installed.manifest.build_id],
            )

    def test_install_rejects_runtime_not_covered_by_manifest(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as name:
            root = Path(name)
            installed = create_release_fixture(root / "installed", payload=b"old\n")
            tampered = create_release_fixture(root / "tampered", payload=b"new\n")
            data_root = root / "data"
            install_fixture(root, data_root, installed)
            before = link_targets(data_root)
            archive = root / "tampered-inventory.tar.zst"
            create_archive(
                archive,
                tampered.release,
                extra_name="mcp/unlisted.js",
            )

            with self.assertRaises(WorkflowError):
                run_install(
                    root,
                    data_root,
                    tampered,
                    archive,
                    tampered.manifest.build_id,
                )

            self.assertEqual(link_targets(data_root), before)
            self.assertEqual(
                sorted(path.name for path in (data_root / "releases").iterdir()),
                [installed.manifest.build_id],
            )


def rewrite_build_id(root: Path, fixture: ReleaseFixture, build_id: str) -> Path:
    release = clone_release(fixture.release, root / "tampered-release")
    manifest = json.loads((release / "manifest.json").read_text(encoding="utf-8"))
    manifest["build_id"] = build_id
    write_manifest_and_checksums(release, manifest)
    archive = root / "tampered-build-id.tar.zst"
    return create_archive(archive, release)


def install_fixture(root: Path, data_root: Path, fixture: ReleaseFixture) -> None:
    run_install(
        root,
        data_root,
        fixture,
        fixture.archive,
        fixture.manifest.build_id,
    )


def run_install(
    root: Path,
    data_root: Path,
    fixture: ReleaseFixture,
    archive: Path,
    build_id: str,
) -> None:
    with (
        patch.object(install, "repository_root", return_value=root),
        redirect_stdout(StringIO()),
    ):
        install.run(
            [
                str(archive),
                "--lock",
                str(fixture.lock),
                "--build-id",
                build_id,
                "--archive-sha256",
                file_sha256(archive),
                "--data-root",
                str(data_root),
            ]
        )


if __name__ == "__main__":
    unittest.main()
