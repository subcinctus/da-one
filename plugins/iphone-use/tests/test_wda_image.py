import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ast  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import struct  # noqa: E402
import tempfile  # noqa: E402
import unittest  # noqa: E402
import zlib  # noqa: E402

import wda_image  # noqa: E402
from cmdrunner import CommandResult  # noqa: E402
from fakes_cmd import FakeRunner, jpeg_out_effect, write_fake_executable  # noqa: E402
from fakes_cmd import TINY_JPEG as CMD_TINY_JPEG  # noqa: E402
from fake_wda import TINY_JPEG  # noqa: E402
from wda_image import (ModelImage, fit_size, jpeg_dimensions, model_image, png_size,  # noqa: E402
                       prune_artifacts, save_png_artifact, solid_png)

ARTIFACT_NAME = re.compile(r"^\d{8}T\d{12}Z-[0-9a-f]{8}\.png$")


def png_header(width, height):
    """Just enough of a PNG for size detection (signature + IHDR)."""
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    crc = struct.pack(">I", zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF)
    return wda_image.PNG_SIGNATURE + struct.pack(">I", 13) + b"IHDR" + ihdr + crc


def segment(marker, payload):
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def sof_payload(width, height, components=3):
    return struct.pack(">BHHB", 8, height, width, components) + b"\x01\x22\x00" * components


APP0 = segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")


def chunks(data):
    """[(type, payload, crc_ok)] of a PNG after the signature."""
    found = []
    index = 8
    while index < len(data):
        length = struct.unpack(">I", data[index:index + 4])[0]
        kind = data[index + 4:index + 8]
        payload = data[index + 8:index + 8 + length]
        crc = struct.unpack(">I", data[index + 8 + length:index + 12 + length])[0]
        found.append((kind, payload, crc == zlib.crc32(kind + payload) & 0xFFFFFFFF))
        index += 12 + length
    return found


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="iu-img-", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write(self, name, data):
        path = os.path.join(self.tmp, name)
        with open(path, "wb") as handle:
            handle.write(data)
        return path


class PngSizeTests(unittest.TestCase):
    def test_reads_ihdr(self):
        self.assertEqual(png_size(solid_png(3, 5)), (3, 5))
        self.assertEqual(png_size(png_header(1170, 2532)), (1170, 2532))
        self.assertEqual(png_size(bytearray(png_header(20000, 1))), (20000, 1))

    def test_rejects_non_png_and_bad_headers(self):
        self.assertIsNone(png_size(b"not a png"))
        self.assertIsNone(png_size(b""))
        self.assertIsNone(png_size(png_header(10, 10)[:23]))
        self.assertIsNone(png_size(TINY_JPEG))
        self.assertIsNone(png_size(None))
        self.assertIsNone(png_size("\x89PNG"))
        wrong_chunk = bytearray(png_header(10, 10))
        wrong_chunk[12:16] = b"IDAT"
        self.assertIsNone(png_size(bytes(wrong_chunk)))

    def test_rejects_out_of_range_sides(self):
        self.assertIsNone(png_size(png_header(0, 10)))
        self.assertIsNone(png_size(png_header(10, 0)))
        self.assertIsNone(png_size(png_header(20001, 10)))
        self.assertIsNone(png_size(png_header(10, 20001)))


class FitSizeTests(unittest.TestCase):
    def test_pinned_device_sizes(self):
        self.assertEqual(fit_size(1320, 2868), (722, 1568))
        self.assertEqual(fit_size(1170, 2532), (725, 1568))
        self.assertEqual(fit_size(1179, 2556), (723, 1568))
        self.assertEqual(fit_size(750, 1334), (750, 1334))

    def test_landscape_square_and_small_images(self):
        self.assertEqual(fit_size(2868, 1320), (1568, 722))
        self.assertEqual(fit_size(1536, 2048), (768, 1024))
        self.assertEqual(fit_size(600, 900), (600, 900))
        self.assertEqual(fit_size(1, 1), (1, 1))
        self.assertEqual(fit_size(4000, 4000), (768, 768))
        self.assertEqual(fit_size(20000, 1), (1568, 1))

    def test_pixel_to_point_for_the_largest_phone(self):
        width, height = fit_size(1320, 2868)
        self.assertEqual([round(440 / width, 4), round(956 / height, 4)], [0.6094, 0.6097])

    def test_limits_are_pinned_inside_claude_vision_envelope(self):
        self.assertLessEqual(wda_image.MAX_LONG_SIDE, 1568)
        self.assertLessEqual(wda_image.MAX_SHORT_SIDE, 768)
        self.assertEqual(wda_image.JPEG_QUALITY, 80)
        # Real iPhone and iPad screenshot sizes, portrait and landscape.
        for size in ((1320, 2868), (1170, 2532), (1179, 2556), (1290, 2796), (1206, 2622), (750, 1334),
                     (1242, 2688), (2048, 2732), (1640, 2360), (2868, 1320), (2532, 1170)):
            width, height = fit_size(*size)
            self.assertLessEqual(max(width, height), 1568)
            self.assertLessEqual(min(width, height), 768)
            self.assertLessEqual(width * height, 1200000, size)

    def test_absolute_bound_for_any_aspect_ratio(self):
        # The largest possible result is 768 x 1568 (about 1.2 MP), reached only near a 1:2.04 aspect.
        for size in ((768, 1568), (5000, 5000), (3000, 6200), (20000, 20000)):
            width, height = fit_size(*size)
            self.assertLessEqual(width * height, 768 * 1568, size)


class JpegDimensionsTests(unittest.TestCase):
    def test_tiny_jpeg_constant(self):
        self.assertEqual(len(TINY_JPEG), 313)
        self.assertEqual(TINY_JPEG, CMD_TINY_JPEG)
        self.assertEqual(TINY_JPEG[:4], b"\xff\xd8\xff\xe0")
        self.assertEqual(TINY_JPEG[-2:], b"\xff\xd9")
        self.assertEqual(jpeg_dimensions(TINY_JPEG), (39, 84))
        self.assertEqual(jpeg_dimensions(bytearray(TINY_JPEG)), (39, 84))

    def test_synthetic_progressive_sof2(self):
        data = b"\xff\xd8" + APP0 + segment(0xC2, sof_payload(800, 600)) + b"\xff\xda" + b"\x00" * 10
        self.assertEqual(jpeg_dimensions(data), (800, 600))

    def test_every_sof_marker_is_recognised(self):
        for marker in wda_image.SOF_MARKERS:
            data = b"\xff\xd8" + segment(marker, sof_payload(12, 34, components=1))
            self.assertEqual(jpeg_dimensions(data), (12, 34), hex(marker))

    def test_non_sof_c4_c8_cc_are_skipped(self):
        data = (b"\xff\xd8" + segment(0xC4, b"\x00" * 20) + segment(0xC8, b"\x00" * 6)
                + segment(0xCC, b"\x00" * 6) + segment(0xC0, sof_payload(5, 6)))
        self.assertEqual(jpeg_dimensions(data), (5, 6))

    def test_fill_bytes_and_standalone_markers(self):
        data = b"\xff\xd8\xff\xff\xff" + APP0[1:] + b"\xff\xd0\xff\x01" + segment(0xC0, sof_payload(7, 9))
        self.assertEqual(jpeg_dimensions(data), (7, 9))

    def test_embedded_exif_thumbnail_does_not_confuse_the_walk(self):
        thumbnail = b"\xff\xd8" + segment(0xC0, sof_payload(1, 1)) + b"\xff\xd9"
        app1 = segment(0xE1, b"Exif\x00\x00" + thumbnail)
        data = b"\xff\xd8" + app1 + segment(0xC0, sof_payload(1179, 2556)) + b"\xff\xda\x00"
        self.assertEqual(jpeg_dimensions(data), (1179, 2556))

    def test_malformed_input_returns_none(self):
        good_sof = segment(0xC0, sof_payload(10, 10))
        cases = {
            "empty": b"",
            "not bytes": "\xff\xd8",
            "no soi": b"\x00\x00" + good_sof,
            "soi only": b"\xff\xd8",
            "short": b"\xff\xd8\xff",
            "scan before frame": b"\xff\xd8" + APP0 + b"\xff\xda\x00\x08" + good_sof,
            "eoi before frame": b"\xff\xd8\xff\xd9" + good_sof,
            "segment past buffer": b"\xff\xd8" + segment(0xE0, b"x" * 10)[:-3],
            "length below two": b"\xff\xd8\xff\xe0\x00\x01" + good_sof,
            "sof too short": b"\xff\xd8" + segment(0xC0, b"\x08\x00\x10"),
            "zero width": b"\xff\xd8" + segment(0xC0, sof_payload(0, 10)),
            "zero height": b"\xff\xd8" + segment(0xC0, sof_payload(10, 0)),
            "too wide": b"\xff\xd8" + segment(0xC0, sof_payload(16385, 10)),
            "garbage instead of marker": b"\xff\xd8\x12\x34" + good_sof,
            "truncated length": b"\xff\xd8\xff\xc0\x00",
            "fill bytes to the end": b"\xff\xd8\xff\xff\xff",
            "png": solid_png(2, 2),
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                self.assertIsNone(jpeg_dimensions(data))

    def test_maximum_side_is_accepted(self):
        data = b"\xff\xd8" + segment(0xC0, sof_payload(16384, 16384))
        self.assertEqual(jpeg_dimensions(data), (16384, 16384))


class ModelImageTests(TempDirCase):
    def setUp(self):
        super().setUp()
        self.bin = os.path.join(self.tmp, "bin")
        self.sips = write_fake_executable(self.bin, "sips", "exit 0\n")
        self.runner = FakeRunner()
        self.big = self.write("20261009T120000000000Z-0a1b2c3d.png", solid_png(1320, 2868))
        self.jpg = self.big[:-4] + ".jpg"

    def convert(self, source=None, **kwargs):
        kwargs.setdefault("runner", self.runner)
        kwargs.setdefault("sips_path", self.sips)
        return model_image(source or self.big, **kwargs)

    def test_success_runs_sips_with_height_before_width_and_returns_private_jpeg(self):
        self.runner.on("sips", effect=jpeg_out_effect())
        result = self.convert()
        self.assertIsInstance(result, ModelImage)
        self.assertEqual(result, ModelImage(self.jpg, "image/jpeg", 722, 1568))
        call = self.runner.calls_for("sips")[0]
        self.assertEqual(call.argv, [self.sips, "-s", "format", "jpeg", "-s", "formatOptions", "80",
                                     "-z", "1568", "722", self.big, "--out", self.jpg])
        self.assertEqual(call.timeout, wda_image.SIPS_TIMEOUT)
        self.assertEqual(stat.S_IMODE(os.stat(self.jpg).st_mode), 0o600)
        with open(self.jpg, "rb") as handle:
            self.assertEqual(handle.read(), TINY_JPEG)
        self.assertTrue(os.path.exists(self.big), "the PNG evidence is kept")

    def test_quality_is_passed_to_sips(self):
        self.runner.on("sips", effect=jpeg_out_effect())
        self.convert(quality=55)
        self.assertEqual(self.runner.calls_for("sips")[0].argv[6], "55")

    def test_accepts_path_objects(self):
        import pathlib

        self.runner.on("sips", effect=jpeg_out_effect())
        result = self.convert(source=pathlib.Path(self.big), sips_path=pathlib.Path(self.sips))
        self.assertEqual(result.path, self.jpg)
        self.assertIsInstance(result.path, str)

    def assert_png_result(self, result):
        self.assertEqual(result, ModelImage(self.big, "image/png", 1320, 2868))
        self.assertFalse(os.path.exists(self.jpg), "no partial JPEG may be left behind")

    def test_failing_run_returns_the_png_and_leaves_no_jpeg(self):
        self.runner.on("sips", returncode=1, stderr="Error")
        self.assert_png_result(self.convert())

    def test_failing_run_that_wrote_a_file_still_cleans_up(self):
        writer = jpeg_out_effect()

        def effect(argv, cwd, env, input_text):
            writer(argv, cwd, env, input_text)
            return CommandResult(13, "", "killed")

        self.runner.on("sips", effect=effect)
        self.assert_png_result(self.convert())

    def test_output_that_is_not_jpeg_is_rejected(self):
        self.runner.on("sips", effect=jpeg_out_effect(b"\x89PNG not a jpeg"))
        self.assert_png_result(self.convert())

    def test_output_shorter_than_four_bytes_is_rejected(self):
        self.runner.on("sips", effect=jpeg_out_effect(b"\xff\xd8"))
        self.assert_png_result(self.convert())

    def test_success_code_without_output_is_rejected_even_with_a_stale_file(self):
        self.write(os.path.basename(self.jpg), TINY_JPEG)  # leftover from an earlier run
        self.runner.on("sips", returncode=0)
        self.assert_png_result(self.convert())

    def test_runner_exception_never_loses_the_screenshot(self):
        def effect(argv, cwd, env, input_text):
            raise RuntimeError("runner exploded")

        self.runner.on("sips", effect=effect)
        self.assert_png_result(self.convert())

    def test_original_keeps_the_png_without_running_sips(self):
        self.runner.on("sips", effect=jpeg_out_effect())
        self.assert_png_result(self.convert(original=True))
        self.assertEqual(self.runner.calls, [])

    def test_non_executable_or_missing_sips_keeps_the_png(self):
        plain = self.write("sips-not-executable", b"#!/bin/sh\nexit 0\n")
        os.chmod(plain, 0o644)
        self.runner.on("sips", effect=jpeg_out_effect())
        self.assert_png_result(self.convert(sips_path=plain))
        self.assert_png_result(self.convert(sips_path=os.path.join(self.tmp, "missing", "sips")))
        self.assertEqual(self.runner.calls, [])

    def test_small_png_is_returned_unchanged(self):
        small = self.write("small.png", png_header(750, 1334))
        self.runner.on("sips", effect=jpeg_out_effect())
        self.assertEqual(self.convert(source=small), ModelImage(small, "image/png", 750, 1334))
        self.assertEqual(self.runner.calls, [])

    def test_not_a_png_reports_unknown_size(self):
        jpeg = self.write("frame.png", TINY_JPEG)
        self.assertEqual(self.convert(source=jpeg), ModelImage(jpeg, "image/png", None, None))
        missing = os.path.join(self.tmp, "missing.png")
        self.assertEqual(self.convert(source=missing), ModelImage(missing, "image/png", None, None))
        self.assertEqual(self.runner.calls, [])

    def test_a_png_already_named_jpg_is_never_touched(self):
        odd = self.write("odd.jpg", solid_png(1320, 2868))
        self.runner.on("sips", effect=jpeg_out_effect())
        self.assertEqual(self.convert(source=odd), ModelImage(odd, "image/png", 1320, 2868))
        self.assertTrue(os.path.exists(odd))

    def test_default_runner_is_the_real_command_runner(self):
        script = ("import sys\n"
                  "out = sys.argv[sys.argv.index('--out') + 1]\n"
                  "open(out, 'wb').write(bytes.fromhex(%r))\n" % TINY_JPEG.hex())
        real_sips = write_fake_executable(self.bin, "sips-real", script, interpreter=sys.executable)
        result = model_image(self.big, sips_path=real_sips)
        self.assertEqual(result, ModelImage(self.jpg, "image/jpeg", 722, 1568))
        self.assertEqual(stat.S_IMODE(os.stat(self.jpg).st_mode), 0o600)

    def test_cmdrunner_is_imported_lazily(self):
        with open(wda_image.__file__, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), feature_version=(3, 9))
        top_level = set()
        for node in tree.body:
            if isinstance(node, ast.Import):
                top_level.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                top_level.add(node.module)
        self.assertNotIn("cmdrunner", top_level)
        self.assertNotIn("errors", top_level)


class SaveArtifactTests(TempDirCase):
    def test_name_mode_directory_and_content(self):
        directory = os.path.join(self.tmp, "state", "artifacts")
        path = save_png_artifact(directory, b"\x89PNG data")
        self.assertRegex(path.name, ARTIFACT_NAME)
        self.assertEqual(str(path.parent), directory)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), 0o700)
        with open(str(path), "rb") as handle:
            self.assertEqual(handle.read(), b"\x89PNG data")

    def test_existing_directory_is_made_private(self):
        directory = os.path.join(self.tmp, "artifacts")
        os.mkdir(directory, 0o755)
        os.chmod(directory, 0o755)
        save_png_artifact(directory, b"x")
        self.assertEqual(stat.S_IMODE(os.stat(directory).st_mode), 0o700)

    def test_names_are_unique_and_sort_chronologically(self):
        directory = os.path.join(self.tmp, "artifacts")
        names = [save_png_artifact(directory, b"%d" % index).name for index in range(20)]
        self.assertEqual(len(set(names)), 20)
        stamps = [name.split("-")[0] for name in names]
        self.assertEqual(stamps, sorted(stamps))

    def test_large_payload_is_written_completely(self):
        data = solid_png(1170, 2532) + os.urandom(1 << 20)
        path = save_png_artifact(os.path.join(self.tmp, "a"), data)
        self.assertEqual(os.path.getsize(str(path)), len(data))


class PruneArtifactsTests(TempDirCase):
    def populate(self, count):
        directory = os.path.join(self.tmp, "artifacts")
        os.makedirs(directory)
        for number in range(count):
            for suffix in (".png", ".jpg"):
                name = "20261009T1200%02d000000Z-%08x%s" % (number, number, suffix)
                with open(os.path.join(directory, name), "wb") as handle:
                    handle.write(b"x")
        with open(os.path.join(directory, "notes.json"), "w") as handle:
            handle.write("{}")
        return directory

    def test_keeps_the_newest_of_each_kind_separately(self):
        directory = self.populate(50)
        os.remove(os.path.join(directory, "20261009T120049000000Z-00000031.jpg"))  # one JPEG fewer
        prune_artifacts(directory, 40)
        pngs = sorted(name for name in os.listdir(directory) if name.endswith(".png"))
        jpgs = sorted(name for name in os.listdir(directory) if name.endswith(".jpg"))
        self.assertEqual(len(pngs), 40)
        self.assertEqual(len(jpgs), 40)
        self.assertEqual(pngs[0], "20261009T120010000000Z-0000000a.png")
        self.assertEqual(jpgs[0], "20261009T120009000000Z-00000009.jpg")
        self.assertTrue(os.path.exists(os.path.join(directory, "notes.json")))

    def test_keep_zero_and_missing_directory(self):
        directory = self.populate(3)
        prune_artifacts(directory, 0)
        self.assertEqual(os.listdir(directory), ["notes.json"])
        prune_artifacts(os.path.join(self.tmp, "does-not-exist"), 5)

    def test_fewer_files_than_keep_is_a_no_op(self):
        directory = self.populate(3)
        prune_artifacts(directory, 40)
        self.assertEqual(len(os.listdir(directory)), 7)


class SolidPngTests(unittest.TestCase):
    def test_structure_crc_and_pixels(self):
        data = solid_png(4, 3, rgb=(1, 2, 3))
        self.assertTrue(data.startswith(wda_image.PNG_SIGNATURE))
        found = chunks(data)
        self.assertEqual([kind for kind, _, _ in found], [b"IHDR", b"IDAT", b"IEND"])
        self.assertTrue(all(ok for _, _, ok in found))
        self.assertEqual(struct.unpack(">IIBBBBB", found[0][1]), (4, 3, 8, 2, 0, 0, 0))
        self.assertEqual(zlib.decompress(found[1][1]), (b"\x00" + b"\x01\x02\x03" * 4) * 3)
        self.assertEqual(found[2][1], b"")
        self.assertEqual(png_size(data), (4, 3))

    def test_default_colour_and_phone_size(self):
        data = solid_png(1170, 2532)
        self.assertEqual(png_size(data), (1170, 2532))
        rows = zlib.decompress(chunks(data)[1][1])
        self.assertEqual(rows[:7], b"\x00\x18\x18\x1c\x18\x18\x1c")
        self.assertLess(len(data), 100000)

    def test_invalid_sides(self):
        for width, height in ((0, 1), (1, 0), (-1, 5)):
            with self.assertRaises(ValueError):
                solid_png(width, height)


if __name__ == "__main__":
    unittest.main()
