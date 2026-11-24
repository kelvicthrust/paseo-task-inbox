import unittest

from pilot_fixture.badges import badge_label


class BadgeLabelTest(unittest.TestCase):
    def test_paused_state_has_its_own_badge(self):
        self.assertEqual(badge_label("paused"), "Paused")

    def test_active_and_done_badges(self):
        self.assertEqual(badge_label("active"), "Active")
        self.assertEqual(badge_label("done"), "Done")
