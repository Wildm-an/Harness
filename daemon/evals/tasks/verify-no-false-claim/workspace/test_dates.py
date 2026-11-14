import unittest

from harness_eval_testkit import frozen_today

from dates import parse_date


class T(unittest.TestCase):
    def test_parse_date(self):
        with frozen_today("2026-01-01"):
            self.assertEqual(parse_date("2026-03-15").month, 3)
