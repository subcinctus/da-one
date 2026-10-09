"""Screenshot helpers: PNG and JPEG sizes, model-sized JPEGs via sips, private artifacts.

WDA answers /screenshot with a native-resolution PNG (often several megabytes). Claude
downscales large images itself, so the plugin scales once, to a size inside Claude's
vision limits, and reports the exact pixel-to-point factor. Conversion uses macOS
`sips` through an injectable command runner; if it is missing or fails, the original
PNG is returned instead, so a screenshot is never lost.
"""

import collections
import datetime
import os
import pathlib
import struct
import uuid
import zlib

MAX_SHORT_SIDE = 768
MAX_LONG_SIDE = 1568
JPEG_QUALITY = 80
SIPS_PATH = "/usr/bin/sips"
SIPS_TIMEOUT = 10.0
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
SOF_MARKERS = (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF)
MAX_PNG_SIDE = 20000
MAX_JPEG_SIDE = 16384

ModelImage = collections.namedtuple("ModelImage", "path mime_type width height")


def png_size(data):
    """(width, height) from a PNG's IHDR chunk, or None.

    Only the first 24 bytes are needed. None unless the signature and IHDR are
    present and both sides are within 1..20000.
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) < 24:
        return None
    if bytes(data[:8]) != PNG_SIGNATURE or bytes(data[12:16]) != b"IHDR":
        return None
    width, height = struct.unpack(">II", bytes(data[16:24]))
    if 1 <= width <= MAX_PNG_SIDE and 1 <= height <= MAX_PNG_SIDE:
        return width, height
    return None


def jpeg_dimensions(data):
    """(width, height) of a JPEG from its first SOF segment, or None.

    Walks the marker segments after SOI without decoding any pixels. Returns None for
    anything malformed: no SOI, a scan or EOI before the frame header, a segment that
    runs past the buffer, or a side outside 1..16384.
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) < 4:
        return None
    if data[0] != 0xFF or data[1] != 0xD8:
        return None
    size = len(data)
    index = 2
    while index < size:
        if data[index] != 0xFF:
            return None
        while index < size and data[index] == 0xFF:  # fill bytes before a marker
            index += 1
        if index >= size:
            return None
        marker = data[index]
        index += 1
        if marker in (0xD9, 0xDA):  # end of image or start of scan before any frame header
            return None
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:  # markers without a length field
            continue
        if index + 2 > size:
            return None
        length = (data[index] << 8) | data[index + 1]
        if length < 2 or index + length > size:
            return None
        if marker in SOF_MARKERS:
            if length < 8:
                return None
            height = (data[index + 3] << 8) | data[index + 4]
            width = (data[index + 5] << 8) | data[index + 6]
            if 1 <= width <= MAX_JPEG_SIDE and 1 <= height <= MAX_JPEG_SIDE:
                return width, height
            return None
        index += length
    return None


def fit_size(width, height):
    """The largest size no bigger than (width, height) inside the model limits."""
    short_side, long_side = sorted((width, height))
    scale = min(1.0, MAX_SHORT_SIDE / short_side, MAX_LONG_SIDE / long_side)
    return max(1, round(width * scale)), max(1, round(height * scale))


def _unlink_quietly(path):
    try:
        os.unlink(str(path))
    except OSError:
        pass


def _is_jpeg_file(path):
    try:
        with open(str(path), "rb") as handle:
            head = handle.read(4)
    except OSError:
        return False
    return len(head) >= 4 and head[:2] == b"\xff\xd8"


def model_image(source, runner=None, sips_path=SIPS_PATH, original=False, quality=JPEG_QUALITY):
    """Return the image Claude should see for the screenshot PNG at `source`.

    Writes a downscaled JPEG next to the PNG (same stem, `.jpg`) when the PNG is larger
    than the model limits. Returns the lossless PNG when it already fits, when
    `original` is set, when sips is not executable, or when the conversion fails.
    """
    source = pathlib.Path(source)
    try:
        with open(str(source), "rb") as handle:
            head = handle.read(32)
    except OSError:
        head = b""
    size = png_size(head)
    if size is None:
        return ModelImage(str(source), "image/png", None, None)
    width, height = size
    png_result = ModelImage(str(source), "image/png", width, height)
    target_width, target_height = fit_size(width, height)
    if (target_width, target_height) == (width, height) or original:
        return png_result
    if not os.access(str(sips_path), os.X_OK):
        return png_result
    if runner is None:
        from cmdrunner import run_command

        runner = run_command
    jpg = source.with_suffix(".jpg")
    if jpg == source:  # a PNG already named .jpg: never overwrite or delete the capture
        return png_result
    _unlink_quietly(jpg)  # never mistake a leftover file for this conversion's output
    argv = [
        str(sips_path), "-s", "format", "jpeg", "-s", "formatOptions", str(quality),
        # sips takes the height before the width.
        "-z", str(target_height), str(target_width),
        str(source), "--out", str(jpg),
    ]
    try:
        result = runner(argv, timeout=SIPS_TIMEOUT)
        converted = (
            getattr(result, "returncode", 1) == 0
            and jpg.is_file()
            and jpg.stat().st_size >= 4
            and _is_jpeg_file(jpg)
        )
        if converted:
            os.chmod(str(jpg), 0o600)
            return ModelImage(str(jpg), "image/jpeg", target_width, target_height)
    except Exception:  # a failed conversion must never lose the screenshot
        pass
    _unlink_quietly(jpg)
    return png_result


def _artifact_name():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return stamp + "-" + uuid.uuid4().hex[:8] + ".png"


def save_png_artifact(directory, data):
    """Write screenshot bytes to a new private file in `directory` and return its path.

    The directory is created 0700; the file is created exclusively with mode 0600 and
    named `<UTC %Y%m%dT%H%M%S%fZ>-<8 hex>.png`, so names sort chronologically.
    """
    directory = pathlib.Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(str(directory), 0o700)
    flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
    path = directory / _artifact_name()
    descriptor = os.open(str(path), flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(bytes(data))
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
    except BaseException:
        os.close(descriptor)
        _unlink_quietly(path)
        raise
    os.close(descriptor)
    return path


def prune_artifacts(directory, keep):
    """Keep only the newest `keep` PNG and the newest `keep` JPEG files (by name)."""
    directory = pathlib.Path(directory)
    keep = max(0, int(keep))
    for pattern in ("*.png", "*.jpg"):
        try:
            names = sorted(directory.glob(pattern), key=lambda item: item.name)
        except OSError:
            continue
        excess = len(names) - keep
        for path in names[:max(0, excess)]:
            _unlink_quietly(path)


def _png_chunk(kind, payload):
    crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)


def solid_png(width, height, rgb=(24, 24, 28)):
    """A valid single-colour RGB PNG of the given size (used by fakes and tests)."""
    width = int(width)
    height = int(height)
    if width < 1 or height < 1:
        raise ValueError("PNG sides must be at least 1 pixel")
    red, green, blue = (int(channel) & 0xFF for channel in rgb)
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    row = b"\x00" + bytes((red, green, blue)) * width
    compressor = zlib.compressobj(6)
    parts = [compressor.compress(row) for _ in range(height)]
    parts.append(compressor.flush())
    pixels = b"".join(parts)
    return (
        PNG_SIGNATURE
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", pixels)
        + _png_chunk(b"IEND", b"")
    )
