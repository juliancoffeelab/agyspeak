import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("key_qr", Path(__file__).resolve().parents[1] / "scripts/key-qr.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class KeyQrTests(unittest.TestCase):
    def test_reads_only_the_supplied_dummy_env(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text('OPENROUTER_API_KEY="sk-or-v1-dummy-key-for-offline-tests"\n')
            self.assertEqual(module.read_key(path), "sk-or-v1-dummy-key-for-offline-tests")
            path.write_text('UNRELATED="not-a-key"\n')
            with self.assertRaises(ValueError):
                module.read_key(path)

    def test_qr_page_contains_svg_without_printing_the_key_as_text(self):
        key = "sk-or-v1-dummy-key-for-offline-tests"
        page = module.qr_page(key).decode()
        self.assertIn("<svg", page)
        self.assertIn("Scan", page)
        self.assertNotIn(key, page)
        self.assertNotIn("https://", page)


if __name__ == "__main__":
    unittest.main()
