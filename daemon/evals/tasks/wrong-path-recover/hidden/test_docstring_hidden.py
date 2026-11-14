import ast
import unittest


class T(unittest.TestCase):
    def test_docstring(self):
        with open("lib/text_utils.py", encoding="utf-8") as f:
            tree = ast.parse(f.read())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "slugify")
        self.assertTrue(ast.get_docstring(fn))

    def test_behavior(self):
        from lib.text_utils import slugify
        self.assertEqual(slugify("Hello, World!"), "hello-world")
