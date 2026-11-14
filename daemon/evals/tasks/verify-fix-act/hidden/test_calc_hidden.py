import unittest

from calc import divide


class H(unittest.TestCase):
    def test_more(self):
        self.assertEqual(divide(9, 3), 3)
        self.assertEqual(divide(1, 4), 0.25)
