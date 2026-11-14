import unittest

import pager
from pager import paginate
from views import page_label


class T(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 0, 3), [0, 1, 2])

    def test_second_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [3, 4, 5])

    def test_label(self):
        self.assertEqual(page_label(1, 3), "4-6")

    def test_new_name(self):
        self.assertTrue(callable(pager._page_bounds))
