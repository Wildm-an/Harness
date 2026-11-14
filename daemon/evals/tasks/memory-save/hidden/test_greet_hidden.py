import unittest

from hello import greet


class T(unittest.TestCase):
    def test_greet(self):
        self.assertEqual(greet("Ann"), "Hello, Ann")
