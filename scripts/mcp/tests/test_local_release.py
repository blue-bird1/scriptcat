from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from dataclasses import dataclass
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from scripts.mcp import install, package
from scripts.mcp._archive import read_manifest
from scripts.mcp._common import WorkflowError
from scripts.mcp._component import materialize_component
from scripts.mcp._identity import BUILD_SCHEMA, PACKAGE_SCHEMA, component_build_id
from scripts.mcp._lock import load_lock

MCP_EXECUTABLE = "mcp/bin/chrome-devtools-mcp.js"
LOCK_NAME = "mcp.lock.json"
ARCHIVE_NAME = "mcp.tar.zst"
SOURCE = "https://github.com/blue-bird1/chrome-devtools-mcp.git"
UPSTREAM_SOURCE = "https://github.com/ChromeDevTools/chrome-devtools-mcp.git"
UPSTREAM_COMMIT = "1" * 40
FIRST_COMMIT = "2" * 40
SECOND_COMMIT = "3" * 40
FIRST_VERSION = "1.5.0"
SECOND_VERSION = "1.6.0"


class LocalMcpReleaseTest(unittest.TestCase):
    def test_package_and_install_preserve_schema_and_links(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            build_root = root / "build"
            data_root = root / "installed"
            first = self.create_product(
                root, build_root, FIRST_COMMIT, FIRST_VERSION, b"first"
            )
            second = self.create_product(
                root, build_root, SECOND_COMMIT, SECOND_VERSION, b"second"
            )

            self.install_product(root, data_root, first)
            self.install_product(root, data_root, second)

            self.assertEqual((data_root / "current").resolve().name, second.release_id)
            self.assertEqual((data_root / "previous").resolve().name, first.release_id)
            current_manifest = read_manifest((data_root / "current").resolve())
            self.assertEqual(current_manifest.build_id, second.release_id)
            self.assertEqual(current_manifest.component_build_id, second.component_id)

    def test_component_and_release_use_schema_five_content_identity(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            product = self.create_product(
                root, root / "build", FIRST_COMMIT, FIRST_VERSION, b"payload"
            )
            component_manifest = json.loads(
                (product.component / "build-manifest.json").read_text(encoding="utf-8")
            )
            release_manifest = read_manifest(product.release)

            self.assertEqual(component_manifest["schema"], BUILD_SCHEMA)
            self.assertEqual(release_manifest.build_id, product.release_id)
            self.assertEqual(PACKAGE_SCHEMA, 5)
            altered = dict(release_manifest.files)
            altered[MCP_EXECUTABLE] = "0" * 64
            from scripts.mcp._identity import release_build_id

            self.assertNotEqual(
                release_build_id(
                    product.component_id, altered, release_manifest.directories
                ),
                product.release_id,
            )

    def test_failed_package_and_install_leave_no_partial_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            build_root = root / "build"
            product = self.create_product(
                root, build_root, FIRST_COMMIT, FIRST_VERSION, b"payload"
            )
            refused_output = root / "refused.tar.zst"
            refused_output.write_bytes(b"occupied")
            with (
                patch.object(package, "repository_root", return_value=root),
                self.assertRaises(WorkflowError),
            ):
                package.run(
                    [
                        "--build-id",
                        product.component_id,
                        "--lock",
                        str(product.lock),
                        "--build-root",
                        str(build_root),
                        "--output",
                        str(refused_output),
                    ]
                )
            self.assertEqual(refused_output.read_bytes(), b"occupied")
            self.assertFalse(Path(f"{refused_output}.sha256").exists())

            data_root = root / "failed-install"
            with (
                patch.object(install, "repository_root", return_value=root),
                self.assertRaises(WorkflowError),
            ):
                install.run(
                    [
                        str(product.archive),
                        "--lock",
                        str(product.lock),
                        "--build-id",
                        product.release_id,
                        "--archive-sha256",
                        "0" * 64,
                        "--data-root",
                        str(data_root),
                    ]
                )
            self.assertFalse(data_root.exists())

    def create_product(
        self,
        root: Path,
        build_root: Path,
        commit: str,
        version: str,
        payload: bytes,
    ) -> Product:
        lock_path = root / f"{commit[:8]}-{LOCK_NAME}"
        write_lock(lock_path, commit, version)
        lock = load_lock(lock_path)
        runtime = root / f"runtime-{commit[:8]}"
        executable = runtime / MCP_EXECUTABLE
        executable.parent.mkdir(parents=True)
        executable.write_bytes(payload)
        component = materialize_component(runtime, build_root / "builds", lock, 1)
        component_id = component_build_id(lock.digest)
        archive = root / f"{commit[:8]}-{ARCHIVE_NAME}"
        with (
            patch.object(package, "repository_root", return_value=root),
            redirect_stdout(StringIO()),
        ):
            package.run(
                [
                    "--build-id",
                    component_id,
                    "--lock",
                    str(lock_path),
                    "--build-root",
                    str(build_root),
                    "--output",
                    str(archive),
                ]
            )
        releases = list((build_root / "releases").glob("release-*"))
        matching = [
            release
            for release in releases
            if read_manifest(release).component_build_id == component_id
        ]
        self.assertEqual(len(matching), 1)
        release = matching[0]
        return Product(
            lock=lock_path,
            component=component,
            component_id=component_id,
            release=release,
            release_id=read_manifest(release).build_id,
            archive=archive,
        )

    def install_product(self, root: Path, data_root: Path, product: Product) -> None:
        digest = hashlib.sha256(product.archive.read_bytes()).hexdigest()
        with (
            patch.object(install, "repository_root", return_value=root),
            redirect_stdout(StringIO()),
        ):
            install.run(
                [
                    str(product.archive),
                    "--lock",
                    str(product.lock),
                    "--build-id",
                    product.release_id,
                    "--archive-sha256",
                    digest,
                    "--data-root",
                    str(data_root),
                ]
            )


@dataclass(frozen=True)
class Product:
    lock: Path
    component: Path
    component_id: str
    release: Path
    release_id: str
    archive: Path


def write_lock(path: Path, commit: str, version: str) -> None:
    payload = {
        "schema_version": 2,
        "chrome_devtools_mcp": {
            "version": version,
            "commit": commit,
            "source": SOURCE,
            "upstream_source": UPSTREAM_SOURCE,
            "upstream_commit": UPSTREAM_COMMIT,
        },
    }
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
