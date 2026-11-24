import unittest

from pilot_fixture.slug import view_slug


class ViewSlugTest(unittest.TestCase):
    def test_repeated_spaces_form_one_separator(self):
        self.assertEqual(view_slug("  Saved   View  "), "saved-view")

    def test_single_word_is_lowercase(self):
        self.assertEqual(view_slug("Inbox"), "inbox")
