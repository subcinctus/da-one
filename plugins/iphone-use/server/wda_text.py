"""Grapheme-safe text splitting and typing timeouts.

WDA types at a fixed number of characters per second and answers only when typing
has finished, so one request for a long text can outlive any HTTP timeout. The
controller therefore types long text in pieces. A piece boundary must never fall
inside a user-perceived character (an emoji family, a flag, an accented letter or a
CR LF pair), or the phone would receive two broken halves.
"""

import unicodedata

ZERO_WIDTH_JOINER = "‍"
REGIONAL_INDICATORS = (0x1F1E6, 0x1F1FF)
SKIN_TONES = (0x1F3FB, 0x1F3FF)
EMOJI_TAGS = (0xE0020, 0xE007F)
VARIATION_SELECTORS = ((0xFE00, 0xFE0F), (0xE0100, 0xE01EF))


def _within(code, bounds):
    low, high = bounds
    return low <= code <= high


def _is_regional_indicator(character):
    return _within(ord(character), REGIONAL_INDICATORS)


def _extends_previous(character):
    """True when this code point belongs to the character that precedes it."""
    if character == ZERO_WIDTH_JOINER:
        return True
    if unicodedata.combining(character) != 0:
        return True
    if unicodedata.category(character) in ("Mn", "Me", "Mc"):
        return True
    code = ord(character)
    if _within(code, SKIN_TONES) or _within(code, EMOJI_TAGS):
        return True
    return any(_within(code, block) for block in VARIATION_SELECTORS)


def safe_boundary(text, index):
    """Whether `text` may be cut right before text[index] without splitting a grapheme."""
    if index <= 0 or index >= len(text):
        return True
    previous = text[index - 1]
    following = text[index]
    if previous == ZERO_WIDTH_JOINER or _extends_previous(following):
        return False
    if previous == "\r" and following == "\n":
        return False
    if _is_regional_indicator(previous) and _is_regional_indicator(following):
        # Flags are pairs of regional indicators: a cut is safe only after an even run.
        run = 0
        cursor = index - 1
        while cursor >= 0 and _is_regional_indicator(text[cursor]):
            run += 1
            cursor -= 1
        return run % 2 == 0
    return True


def split_text(text, size):
    """Split `text` into ordered pieces of at most `size` code points.

    The cut is moved back (never below half a piece) to the nearest safe boundary.
    An unbreakable run longer than that is cut at `size` anyway, so typing never
    stalls. The pieces always join back to exactly `text`.
    """
    if size < 1:
        raise ValueError("size must be at least 1")
    pieces = []
    start = 0
    while len(text) - start > size:
        end = start + size
        floor = start + max(1, size // 2)
        while end > floor and not safe_boundary(text, end):
            end -= 1
        if not safe_boundary(text, end):
            end = start + size
        pieces.append(text[start:end])
        start = end
    if start < len(text):
        pieces.append(text[start:])
    return pieces


def request_timeout(length, frequency=30, floor=15.0):
    """Seconds to allow for typing `length` characters at `frequency` per second.

    Typing takes length / frequency seconds; allow twice that plus ten seconds of
    overhead, and never less than `floor`.
    """
    return max(floor, length / frequency * 2 + 10)
