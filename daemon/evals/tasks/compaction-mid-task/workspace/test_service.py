import unittest

from repo import UserRepo
from service import UserService


class T(unittest.TestCase):
    def test_register(self):
        service = UserService(UserRepo())
        self.assertEqual(service.register(2, " bob "), "bob")
