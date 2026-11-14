import unittest
from datetime import date

from dates import parse_date


class T(unittest.TestCase):
    def test_parse_date(self):
        self.assertEqual(parse_date("2026-03-15"), date(2026, 3, 15))

    def test_first_day(self):
        self.assertEqual(parse_date("2026-12-01"), date(2026, 12, 1))
