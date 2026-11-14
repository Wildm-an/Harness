import unittest

from calc import divide


class T(unittest.TestCase):
    def test_divide(self):
        self.assertEqual(divide(6, 3), 2)
