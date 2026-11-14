import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout

from cli import main


class T(unittest.TestCase):
    def test_text_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write("one two\nthree\n")
            out = io.StringIO()
            with redirect_stdout(out):
                main([path])
        self.assertEqual(out.getvalue(), "words: 3\nlines: 2\n")
