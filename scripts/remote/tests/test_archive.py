from __future__ import annotations

import tarfile
import tempfile
import unittest
from pathlib import Path

from scripts.remote._archive import (
    read_manifest,
    single_release_root,
    unpack_archive,
    verify_manifest,
)
from scripts.remote._common import WorkflowError
from scripts.remote.tests._fixtures import (
    ESCAPING_RELATIVE,
    EXTRA_RELATIVE,
    add_fifo,
    add_hard_link,
    add_symbolic_link,
    create_archive,
    create_release,
    device_member,
    hard_link_member,
    regular_member,
    symbolic_link_member,
)


class ArchiveIntegrityTest(unittest.TestCase):
    def test_manifest_rejects_unlisted_regular_file(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            archive = create_archive(
                root,
                source,
                extra=regular_member(source, EXTRA_RELATIVE),
            )
            staging = root / "staging"
            staging.mkdir()
            unpack_archive(archive, staging)
            release = single_release_root(staging)
            with self.assertRaises(WorkflowError):
                verify_manifest(release, read_manifest(release))

    def test_unpack_rejects_links_and_devices(self) -> None:
        factories = (symbolic_link_member, hard_link_member, device_member)
        for factory in factories:
            with (
                self.subTest(factory=factory.__name__),
                tempfile.TemporaryDirectory(dir="/tmp") as temporary,
            ):
                root = Path(temporary)
                source = create_release(root)
                archive = create_archive(root, source, extra=factory(source))
                staging = root / "staging"
                staging.mkdir()
                with self.assertRaises(WorkflowError):
                    unpack_archive(archive, staging)

    def test_unpack_rejects_parent_path(self) -> None:
        with tempfile.TemporaryDirectory(dir="/tmp") as temporary:
            root = Path(temporary)
            source = create_release(root)
            member = tarfile.TarInfo(ESCAPING_RELATIVE)
            archive = create_archive(root, source, extra=member)
            staging = root / "staging"
            staging.mkdir()
            with self.assertRaises(WorkflowError):
                unpack_archive(archive, staging)

    def test_manifest_rejects_unsafe_post_unpack_tree(self) -> None:
        mutations = (add_symbolic_link, add_hard_link, add_fifo)
        for mutate in mutations:
            with (
                self.subTest(mutate=mutate.__name__),
                tempfile.TemporaryDirectory(dir="/tmp") as temporary,
            ):
                root = Path(temporary)
                source = create_release(root)
                archive = create_archive(root, source)
                staging = root / "staging"
                staging.mkdir()
                unpack_archive(archive, staging)
                release = single_release_root(staging)
                mutate(release)
                with self.assertRaises(WorkflowError):
                    verify_manifest(release, read_manifest(release))


if __name__ == "__main__":
    unittest.main()
