from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
MCP_CLI_SCRIPTS = tuple(
    REPOSITORY_ROOT / "scripts" / "remote" / "mcp" / name
    for name in ("build.py", "package.py", "install.py")
)


class McpCliHelpContractTest(unittest.TestCase):
    def test_each_stage_documents_a_real_invocation(self) -> None:
        for script in MCP_CLI_SCRIPTS:
            with self.subTest(script=script.name):
                completed = subprocess.run(
                    (sys.executable, str(script), "--help"),
                    check=False,
                    text=True,
                    capture_output=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertIn("Example:", completed.stdout)


if __name__ == "__main__":
    unittest.main()
