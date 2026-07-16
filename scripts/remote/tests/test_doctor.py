from __future__ import annotations

import unittest

from scripts.remote import doctor
from scripts.remote._common import WorkflowError


class LegacyDoctorMigrationTest(unittest.TestCase):
    def test_legacy_doctor_never_selects_or_checks_a_product(self) -> None:
        with self.assertRaisesRegex(WorkflowError, "deprecated"):
            doctor.run(())


if __name__ == "__main__":
    unittest.main()
