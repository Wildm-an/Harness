import unittest

from repo import UserRepository
from service import UserService


class T(unittest.TestCase):
    def test_new_name(self):
        self.assertIsInstance(UserService().repo, UserRepository)
