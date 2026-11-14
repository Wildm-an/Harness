import unittest

from repo import UserRepo


class T(unittest.TestCase):
    def test_add_get(self):
        repo = UserRepo()
        repo.add(1, "ann")
        self.assertEqual(repo.get(1), "ann")
