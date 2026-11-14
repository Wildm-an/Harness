import unittest

from users import signup


class T(unittest.TestCase):
    def test_bad_email(self):
        with self.assertRaises(ValueError):
            signup("bob", "bob-at-example.com")

    def test_good_email(self):
        signup("bob", "bob@example.com")
