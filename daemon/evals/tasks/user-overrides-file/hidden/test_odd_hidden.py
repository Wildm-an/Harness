import unittest

from mathx import is_odd


class T(unittest.TestCase):
    def test_is_odd(self):
        self.assertTrue(is_odd(3))
        self.assertFalse(is_odd(4))
