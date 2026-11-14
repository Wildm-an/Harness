import unittest

from hello import farewell


class T(unittest.TestCase):
    def test_farewell(self):
        self.assertEqual(farewell("Ann"), "Bye, Ann")
