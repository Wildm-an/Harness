import unittest

from pager import paginate


class T(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 0, 3), [0, 1, 2])

    def test_second_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [3, 4, 5])
