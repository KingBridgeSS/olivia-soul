"""Check safe service arguments without loading CUDA or model dependencies."""
from pathlib import Path
import subprocess
import sys
import unittest

SERVICE = Path(__file__).with_name("avatar_service.py")


class ServiceArguments(unittest.TestCase):
    def test_help_without_dependencies(self):
        result = subprocess.run([sys.executable, str(SERVICE), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--portrait", result.stdout)
        self.assertIn("--flashhead-root", result.stdout)

    def test_rejects_public_bind_and_invalid_ports_before_imports(self):
        for args in [["--host", "0.0.0.0"], ["--port", "0"], ["--port", "65536"]]:
            result = subprocess.run([sys.executable, str(SERVICE), *args], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertNotIn("ModuleNotFoundError", result.stderr)


if __name__ == "__main__":
    unittest.main()
