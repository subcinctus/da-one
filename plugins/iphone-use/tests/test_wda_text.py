import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ast  # noqa: E402
import random  # noqa: E402
import unittest  # noqa: E402

import wda_text  # noqa: E402
from wda_text import request_timeout, safe_boundary, split_text  # noqa: E402

FAMILY = "\U0001F468‍\U0001F469‍\U0001F467"  # man ZWJ woman ZWJ girl (5 code points)
FLAG_CN = "\U0001F1E8\U0001F1F3"
FLAG_US = "\U0001F1FA\U0001F1F8"
THUMBS_MEDIUM = "\U0001F44D\U0001F3FD"  # thumbs up + skin tone
E_ACUTE = "é"
ENGLAND = "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"  # black flag + tag sequence
HEART_EMOJI = "❤️"  # heart + VS16
IDEOGRAPH_VS = "葛\U000E0100"  # ideograph + ideographic variation selector


def assert_no_unsafe_cuts(test, text, pieces):
    test.assertEqual("".join(pieces), text)
    offset = 0
    for piece in pieces[:-1]:
        offset += len(piece)
        test.assertTrue(safe_boundary(text, offset), "unsafe cut at %d" % offset)


class SafeBoundaryTests(unittest.TestCase):
    def test_ends_and_out_of_range_are_safe(self):
        self.assertTrue(safe_boundary("abc", 0))
        self.assertTrue(safe_boundary("abc", 3))
        self.assertTrue(safe_boundary("abc", -1))
        self.assertTrue(safe_boundary("abc", 99))
        self.assertTrue(safe_boundary("", 0))

    def test_plain_text_is_safe_everywhere(self):
        for index in range(1, 5):
            self.assertTrue(safe_boundary("hello", index))

    def test_zero_width_joiner_sequences_are_kept_whole(self):
        text = "a" + FAMILY + "b"
        safe = [index for index in range(1, len(text)) if safe_boundary(text, index)]
        self.assertEqual(safe, [1, 1 + len(FAMILY)])

    def test_combining_marks_stay_with_their_base(self):
        text = "x" + E_ACUTE + "y"
        self.assertFalse(safe_boundary(text, 2))  # before U+0301
        self.assertTrue(safe_boundary(text, 1))
        self.assertTrue(safe_boundary(text, 3))

    def test_spacing_marks_category_mc_extend(self):
        text = "का"  # Devanagari KA + vowel sign AA (Mc)
        self.assertFalse(safe_boundary(text, 1))

    def test_enclosing_marks_category_me_extend(self):
        text = "1⃣"  # digit + combining enclosing keycap (Me)
        self.assertFalse(safe_boundary(text, 1))

    def test_cr_lf_is_one_unit_but_lf_cr_is_not(self):
        self.assertFalse(safe_boundary("a\r\nb", 2))
        self.assertTrue(safe_boundary("a\r\nb", 1))
        self.assertTrue(safe_boundary("a\r\nb", 3))
        self.assertTrue(safe_boundary("a\n\rb", 2))

    def test_skin_tone_modifiers_extend(self):
        self.assertFalse(safe_boundary(THUMBS_MEDIUM, 1))
        for tone in range(0x1F3FB, 0x1F400):
            self.assertFalse(safe_boundary("\U0001F44B" + chr(tone), 1))

    def test_variation_selectors_extend(self):
        self.assertFalse(safe_boundary(HEART_EMOJI, 1))
        self.assertFalse(safe_boundary(IDEOGRAPH_VS, 1))
        self.assertFalse(safe_boundary("a︀", 1))
        self.assertFalse(safe_boundary("a\U000E01EF", 1))

    def test_tag_sequences_extend(self):
        for index in range(1, len(ENGLAND)):
            self.assertFalse(safe_boundary(ENGLAND, index), index)

    def test_flags_split_only_between_pairs(self):
        text = FLAG_CN + FLAG_US + FLAG_CN  # six regional indicators
        self.assertEqual([index for index in range(1, 6) if safe_boundary(text, index)], [2, 4])

    def test_flag_run_parity_counts_from_the_run_start(self):
        text = "x" + FLAG_CN + FLAG_US
        self.assertTrue(safe_boundary(text, 3))
        self.assertFalse(safe_boundary(text, 2))
        self.assertFalse(safe_boundary(text, 4))


class SplitTextTests(unittest.TestCase):
    def test_family_emoji_probe(self):
        text = "a" * 199 + FAMILY + "b" * 10
        pieces = split_text(text, 200)
        self.assertEqual([len(piece) for piece in pieces], [199, 15])
        self.assertEqual("".join(pieces), text)

    def test_flag_pairs_are_not_split(self):
        text = "a" * 199 + FLAG_CN + FLAG_US
        pieces = split_text(text, 200)
        self.assertEqual([len(piece) for piece in pieces], [199, 4])
        text = "a" * 198 + FLAG_CN + FLAG_US
        pieces = split_text(text, 200)
        self.assertEqual([len(piece) for piece in pieces], [200, 2])
        assert_no_unsafe_cuts(self, text, pieces)

    def test_combining_marks_and_crlf_probes(self):
        text = "a" * 199 + E_ACUTE + "z"
        self.assertEqual([len(piece) for piece in split_text(text, 200)], [199, 3])
        text = "a" * 199 + "\r\n" + "z"
        self.assertEqual([len(piece) for piece in split_text(text, 200)], [199, 3])

    def test_skin_tone_variation_and_tag_probes(self):
        for cluster in (THUMBS_MEDIUM, HEART_EMOJI, IDEOGRAPH_VS, ENGLAND):
            with self.subTest(cluster=cluster):
                text = "a" * 199 + cluster + "z"
                pieces = split_text(text, 200)
                self.assertEqual(len(pieces[0]), 199)
                assert_no_unsafe_cuts(self, text, pieces)

    def test_pieces_rejoin_and_respect_size(self):
        text = "你好，世界 hello " * 80
        for size in (1, 7, 200, 5000):
            with self.subTest(size=size):
                pieces = split_text(text, size)
                self.assertEqual("".join(pieces), text)
                self.assertTrue(all(0 < len(piece) <= size for piece in pieces))

    def test_graphemes_are_not_separated_in_a_mixed_corpus(self):
        text = ("ab" + FAMILY + FLAG_CN + FLAG_US + E_ACUTE + THUMBS_MEDIUM + "\r\n") * 60
        for size in (9, 10, 11, 50, 200):
            with self.subTest(size=size):
                assert_no_unsafe_cuts(self, text, split_text(text, size))

    def test_unbreakable_run_is_cut_at_size_rather_than_stalling(self):
        text = "́" * 50
        pieces = split_text(text, 8)
        self.assertEqual("".join(pieces), text)
        self.assertTrue(all(len(piece) == 8 for piece in pieces[:-1]))

    def test_cut_never_moves_back_more_than_half_a_piece(self):
        text = "a" * 5 + "́" * 20
        pieces = split_text(text, 10)
        self.assertEqual("".join(pieces), text)
        self.assertGreaterEqual(len(pieces[0]), 5)

    def test_short_and_empty_text(self):
        self.assertEqual(split_text("", 5), [])
        self.assertEqual(split_text("abc", 5), ["abc"])
        self.assertEqual(split_text("abcde", 5), ["abcde"])
        self.assertEqual(split_text("abcdef", 5), ["abcde", "f"])

    def test_size_below_one_is_rejected(self):
        for size in (0, -1):
            with self.assertRaises(ValueError):
                split_text("abc", size)

    def test_join_invariant_over_a_seeded_random_corpus(self):
        alphabet = ["a", "b", " ", "\n", "\r", "\r\n", "é", E_ACUTE, FAMILY, FLAG_CN, FLAG_US,
                    "\U0001F1E6", THUMBS_MEDIUM, HEART_EMOJI, ENGLAND, "‍", "́", "你",
                    "\U0001F600", "️"]
        generator = random.Random(20261009)
        for _ in range(300):
            text = "".join(generator.choice(alphabet) for _ in range(generator.randint(0, 120)))
            size = generator.randint(1, 40)
            pieces = split_text(text, size)
            self.assertEqual("".join(pieces), text)
            self.assertTrue(all(0 < len(piece) <= size for piece in pieces))


class RequestTimeoutTests(unittest.TestCase):
    def test_pinned_values(self):
        self.assertAlmostEqual(request_timeout(200, 30), 23.333333333, places=6)
        self.assertEqual(request_timeout(300, 30), 30)
        self.assertEqual(request_timeout(600, 30), 50)
        self.assertEqual(request_timeout(30, 30), 15)

    def test_floor_and_default_frequency(self):
        self.assertEqual(request_timeout(1, 30, floor=20.0), 20.0)
        self.assertEqual(request_timeout(300), 30)
        self.assertGreater(request_timeout(200, 30), 200 / 30)

    def test_module_imports_only_the_standard_library(self):
        with open(wda_text.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), feature_version=(3, 9))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported.add(node.module)
        self.assertEqual(imported, {"unicodedata"})


if __name__ == "__main__":
    unittest.main()
