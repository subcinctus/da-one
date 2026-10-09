import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import inspect  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import stat  # noqa: E402
import unittest  # noqa: E402
import urllib.error  # noqa: E402
import urllib.parse  # noqa: E402
from unittest import mock  # noqa: E402

import privstate  # noqa: E402
import wda_apps  # noqa: E402
from errors import ToolError  # noqa: E402
from fake_usbmuxd import short_tmpdir  # noqa: E402
from fakes_cmd import FakeClock, FakeRunner, json_output_effect  # noqa: E402

UDID = "00008110-001A2B3C4D5E6F7A"
OTHER_UDID = "00008120-0011223344556677"
INSTALLED = {"result": {"apps": [
    {"name": "Notes", "bundleIdentifier": "com.apple.mobilenotes", "builtByDeveloper": False},
    {"name": "WhatsApp", "bundleIdentifier": "net.whatsapp.WhatsApp", "removable": True},
    {"name": "Private unrelated app", "bundleIdentifier": "com.private.secret"},
]}}
APPLE = {"resultCount": 2, "results": [
    {"kind": "software", "bundleId": "com.example.expenses", "trackId": 1234567890, "trackName": "Expense Tracker",
     "artistName": "Example Ltd", "artworkUrl512": "https://example.invalid/icon.png", "description": "Promo"},
    {"kind": "software", "bundleId": "com.example.expenses.pro", "trackId": 1234567891,
     "trackName": "Expense Tracker Pro", "artistName": "Example Ltd"},
]}


class Fetcher:
    """Injected Apple fetch: records URLs, returns a document or raises."""

    def __init__(self, document=None, error=None):
        self.document = APPLE if document is None else document
        self.error = error
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        if self.error is not None:
            raise self.error
        return json.loads(json.dumps(self.document))


def offline(url):
    raise AssertionError("Apple must not be contacted: %s" % url)


class AppsCase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(short_tmpdir())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state = os.path.join(self.tmp, "state")
        privstate.prepare_state_dir(self.state)
        self.runner = FakeRunner()

    def catalog(self, fetch=offline, **config):
        if config:
            privstate.write_json_private(os.path.join(self.state, "config.json"), config)
        return wda_apps.AppCatalog(self.state, runner=self.runner, fetch=fetch)

    def device_apps(self, document=INSTALLED, **kwargs):
        self.runner.on("xcrun", "devicectl", "device", "info", "apps", effect=json_output_effect(document), **kwargs)

    def lookup_error(self, catalog, *args, **kwargs):
        with self.assertRaises(ToolError) as caught:
            catalog.lookup(*args, **kwargs)
        return caught.exception


class CatalogTests(AppsCase):
    def test_catalog_aliases_offline(self):
        catalog = self.catalog()
        for query, bundle in (("Settings", "com.apple.Preferences"), ("WhatsApp", "net.whatsapp.WhatsApp"),
                              ("preferences", "com.apple.Preferences"), ("  apple   notes ", "com.apple.mobilenotes"),
                              ("iMessage", "com.apple.MobileSMS"), ("Teams", "com.microsoft.skype.teams"),
                              ("twitter", "com.atebits.Tweetie2"), ("com.apple.Maps", "com.apple.Maps")):
            with self.subTest(query=query):
                result = catalog.lookup(query, source="catalog")
                self.assertEqual([row["bundle_id"] for row in result["candidates"]], [bundle])
                row = result["candidates"][0]
                self.assertEqual(row["origin"], "catalog")
                self.assertFalse(row["installed_verified"])
                self.assertFalse(row["installation_checked"])
                self.assertTrue(row["publisher"])
                self.assertEqual(result["searched_sources"], ["catalog"])
        self.assertEqual(self.runner.calls, [])

    def test_exact_matches_hide_substring_matches(self):
        catalog = self.catalog()
        result = catalog.lookup("Maps", source="catalog")
        self.assertEqual([row["bundle_id"] for row in result["candidates"]], ["com.apple.Maps"])
        self.assertEqual(result["total_matches"], 1)
        result = catalog.lookup("Messenger", source="catalog")
        self.assertEqual([row["bundle_id"] for row in result["candidates"]], ["com.facebook.Messenger"])

    def test_limit_dedupe_and_no_guessing(self):
        catalog = self.catalog()
        result = catalog.lookup("micro", source="catalog", limit=2)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertGreater(result["total_matches"], 2)
        bundles = [row["bundle_id"] for row in catalog.lookup("micro", source="catalog", limit=30)["candidates"]]
        self.assertEqual(len(bundles), len(set(bundles)))
        self.assertEqual(catalog.lookup("unknown app 999", source="catalog")["candidates"], [])

    def test_catalog_file_invariants(self):
        with open(str(wda_apps.CATALOG_PATH), encoding="utf-8") as handle:
            document = json.load(handle)
        self.assertEqual(document["schemaVersion"], 2)
        self.assertIn("source of truth", document["note"])
        apps = document["apps"]
        self.assertGreaterEqual(len(apps), 50)
        bundles = [app["bundleId"] for app in apps]
        self.assertEqual(len(bundles), len(set(bundles)))
        for app in apps:
            with self.subTest(app=app.get("name")):
                self.assertEqual(set(app), {"name", "aliases", "bundleId", "publisher", "kind"})
                self.assertRegex(app["bundleId"], "^" + wda_apps.BUNDLE_RE + "$")
                self.assertTrue(app["name"].strip())
                self.assertTrue(app["aliases"])
                self.assertTrue(all(isinstance(alias, str) and alias.strip() for alias in app["aliases"]))
                self.assertTrue(app["publisher"].strip())
                self.assertIn(app["kind"], ("apple", "thirdparty"))
                if app["kind"] == "apple":
                    self.assertTrue(app["bundleId"].startswith("com.apple."))
                    self.assertEqual(app["publisher"], "Apple")
        names = {app["name"]: app["bundleId"] for app in apps}
        for name, bundle in (("Settings", "com.apple.Preferences"), ("Safari", "com.apple.mobilesafari"),
                             ("Wallet", "com.apple.Passbook"), ("Watch", "com.apple.Bridge"),
                             ("WhatsApp", "net.whatsapp.WhatsApp"), ("Outlook", "com.microsoft.Office.Outlook"),
                             ("Slack", "com.tinyspeck.chatlyio"), ("Zoom", "us.zoom.videomeetings")):
            self.assertEqual(names[name], bundle)
        self.assertEqual(len(wda_apps.load_catalog(wda_apps.CATALOG_PATH)), len(apps))

    def test_bad_catalog_entries_are_skipped(self):
        path = os.path.join(self.tmp, "catalog.json")
        with open(path, "w") as handle:
            json.dump({"apps": [{"name": "Good", "aliases": ["G"], "bundleId": "com.good.app", "publisher": "G"},
                                {"name": "Bad", "bundleId": "../etc/passwd"}, {"name": "", "bundleId": "com.x.y"},
                                {"name": "Dupe", "bundleId": "com.good.app"}, "text"]}, handle)
        rows = wda_apps.load_catalog(path)
        self.assertEqual([row["bundle_id"] for row in rows], ["com.good.app"])
        self.assertEqual(wda_apps.load_catalog(os.path.join(self.tmp, "missing.json")), [])


class InstalledTests(AppsCase):
    def test_devicectl_formats_and_invalid_entries(self):
        rows = wda_apps.parse_installed({"result": {"apps": [
            {"name": "Notes", "bundleIdentifier": "com.apple.mobilenotes"},
            {"displayName": "Legacy Bank", "bundleId": "com.bank.legacy_app"},
            {"name": "duplicate", "bundleID": "com.apple.mobilenotes"},
            {"name": "malformed", "bundleIdentifier": "../not-a-bundle"},
            {"name": None, "bundleIdentifier": "com.example.noname"},
            None, "text"]}})
        self.assertEqual(rows, [{"name": "Notes", "bundle_id": "com.apple.mobilenotes"},
                                {"name": "Legacy Bank", "bundle_id": "com.bank.legacy_app"},
                                {"name": "com.example.noname", "bundle_id": "com.example.noname"}])
        rows = wda_apps.parse_installed({"result": {"installedApps": {
            "com.example.app": {"displayName": "Example"}, "com.example.bad": "text"}}})
        self.assertEqual(rows, [{"name": "Example", "bundle_id": "com.example.app"}])
        for document in ({}, None, {"result": []}, {"result": {"apps": "x"}}):
            self.assertEqual(wda_apps.parse_installed(document), [])

    def test_installed_first_merge_private_cache_and_one_query(self):
        self.device_apps()
        catalog = self.catalog(udid=UDID)
        result = catalog.lookup("Notes")
        again = catalog.lookup("Apple Notes")
        self.assertEqual(len(self.runner.calls_for("xcrun")), 1)
        call = self.runner.calls_for("xcrun")[0]
        self.assertEqual(call.argv[:8], ["xcrun", "devicectl", "device", "info", "apps", "--device", UDID,
                                         "--include-all-apps"])
        self.assertEqual(call.argv[8], "--json-output")
        self.assertTrue(call.argv[9].startswith(self.state))
        self.assertFalse(os.path.exists(call.argv[9]))
        self.assertEqual(call.argv[10:], ["--timeout", "8"])
        self.assertEqual(call.timeout, 10)
        self.assertEqual(result["candidates"], [{
            "name": "Notes", "bundle_id": "com.apple.mobilenotes", "aliases": ["Apple Notes", "iPhone Notes"],
            "publisher": "Apple", "origin": "installed", "installed_verified": True, "installation_checked": True}])
        self.assertEqual(result["total_matches"], 1)
        self.assertEqual(result["searched_sources"], ["installed", "catalog"])
        self.assertEqual(result["warnings"], [])
        self.assertIn("iphone_launch_app", result["next_action"])
        self.assertNotIn("com.private.secret", json.dumps(result))
        self.assertEqual(again["candidates"][0]["bundle_id"], "com.apple.mobilenotes")
        self.assertEqual(again["candidates"][0]["origin"], "installed")
        cache = os.path.join(self.state, "apps-installed-cache.json")
        self.assertEqual(stat.S_IMODE(os.stat(cache).st_mode), 0o600)
        stored = privstate.read_json(cache)
        self.assertNotIn(UDID, json.dumps(stored))
        self.assertEqual(len(stored["apps"]), 3)

    def test_english_alias_finds_the_installed_app(self):
        self.device_apps()
        result = self.catalog(udid=UDID).lookup("whats app", source="installed")
        self.assertEqual([row["bundle_id"] for row in result["candidates"]], ["net.whatsapp.WhatsApp"])
        self.assertTrue(result["candidates"][0]["installed_verified"])
        self.assertEqual(result["searched_sources"], ["installed"])

    def test_cache_expiry_and_device_change_refresh_the_inventory(self):
        self.device_apps()
        catalog = self.catalog(udid=UDID)
        clock = FakeClock(start=50000.0)
        with mock.patch.object(wda_apps, "time", clock):
            catalog.lookup("Notes", source="installed")
            clock.advance(299)
            catalog.lookup("Notes", source="installed")
            self.assertEqual(len(self.runner.calls_for("xcrun")), 1)
            clock.advance(2)
            catalog.lookup("Notes", source="installed")
            self.assertEqual(len(self.runner.calls_for("xcrun")), 2)
            privstate.write_json_private(os.path.join(self.state, "config.json"), {"udid": OTHER_UDID})
            catalog.lookup("Notes", source="installed")
            self.assertEqual(len(self.runner.calls_for("xcrun")), 3)
            self.assertEqual(self.runner.calls_for("xcrun")[-1].argv[6], OTHER_UDID)
            clock.advance(-1000)  # a clock that went backwards never trusts the cache
            catalog.lookup("Notes", source="installed")
            self.assertEqual(len(self.runner.calls_for("xcrun")), 4)

    def test_missing_or_invalid_udid_runs_nothing(self):
        catalog = self.catalog()
        error = self.lookup_error(catalog, "Notes", source="installed")
        self.assertEqual(error.code, "app_lookup_unavailable")
        self.assertIn("iphone_setup", error.message)
        self.assertEqual(error.details["warnings"], [wda_apps.NO_DEVICE_WARNING])
        self.assertEqual(error.details["candidates"], [])
        self.assertEqual(error.details["searched_sources"], ["installed"])
        self.assertIs(error.details["action_executed"], False)
        self.assertFalse(error.uncertain)
        catalog = self.catalog(udid="$(touch /tmp/unsafe)")
        self.assertEqual(self.lookup_error(catalog, "Notes", source="installed").code, "app_lookup_unavailable")
        result = catalog.lookup("Notes")
        self.assertEqual(result["candidates"][0]["origin"], "catalog")
        self.assertEqual(result["warnings"], [wda_apps.NO_DEVICE_WARNING])
        self.assertEqual(self.runner.calls, [])

    def test_failed_installed_probe_never_claims_installation(self):
        self.runner.on("xcrun", "devicectl", returncode=1, stderr="ERROR: The device is locked.")
        result = self.catalog(udid=UDID).lookup("Notes")
        row = result["candidates"][0]
        self.assertEqual(row["origin"], "catalog")
        self.assertFalse(row["installation_checked"])
        self.assertFalse(row["installed_verified"])
        self.assertEqual(result["warnings"], [wda_apps.LIST_FAILED_WARNING])
        self.assertFalse(os.path.exists(os.path.join(self.state, "apps-installed-cache.json")))

    def test_timeout_or_missing_devicectl(self):
        for code in (124, 127):
            with self.subTest(code=code):
                runner = FakeRunner().on("xcrun", returncode=code)
                catalog = wda_apps.AppCatalog(self.state, runner=runner, fetch=offline)
                privstate.write_json_private(os.path.join(self.state, "config.json"), {"udid": UDID})
                error = self.lookup_error(catalog, "Notes", source="installed")
                self.assertEqual(error.details["warnings"], [wda_apps.LIST_UNAVAILABLE_WARNING])

    def test_runner_success_without_a_list_is_a_failure(self):
        self.device_apps(document={"result": {"deviceIdentifier": "x"}})
        error = self.lookup_error(self.catalog(udid=UDID), "Notes", source="installed")
        self.assertEqual(error.details["warnings"], [wda_apps.LIST_FAILED_WARNING])


class AppleTests(AppsCase):
    def test_parse_dedupes_and_filters(self):
        document = json.loads(json.dumps(APPLE))
        document["results"].extend([
            dict(APPLE["results"][0]), None, "text",
            {"bundleId": "com.fake.app", "trackId": True, "trackName": "Fake"},
            {"kind": "song", "bundleId": "com.fake.song", "trackId": 1, "trackName": "Song"},
            {"kind": "software", "bundleId": "bad bundle", "trackId": 2, "trackName": "Bad"},
            {"kind": "software", "bundleId": "com.fake.noname", "trackId": 3, "trackName": "  "},
            {"bundleId": "com.fake.zero", "trackId": 0, "trackName": "Zero"},
            {"bundleId": "com.fake.nokind", "trackId": 4, "trackName": "No kind"},
        ])
        rows = wda_apps.parse_apple(document, "in")
        self.assertEqual([row["bundle_id"] for row in rows],
                         ["com.example.expenses", "com.example.expenses.pro", "com.fake.nokind"])
        self.assertEqual(rows[0]["store_url"], "https://apps.apple.com/in/app/id1234567890")
        self.assertEqual(rows[0]["publisher"], "Example Ltd")
        self.assertNotIn("artworkUrl512", rows[0])
        self.assertEqual(wda_apps.parse_apple({"results": "x"}, "in"), [])
        self.assertEqual(wda_apps.parse_apple(None, "in"), [])

    def test_query_escaping_cache_and_no_device_data(self):
        self.device_apps()
        fetch = Fetcher()
        catalog = self.catalog(fetch=fetch, udid=UDID)
        query = "expense & country=us $(anything)"
        result = catalog.lookup(query, source="apple", limit=3)
        catalog.lookup(query, source="apple", limit=3)
        self.assertEqual(len(fetch.urls), 1)
        url = fetch.urls[0]
        self.assertTrue(wda_apps.api_url_allowed(url))
        parts = urllib.parse.urlsplit(url)
        self.assertEqual((parts.scheme, parts.netloc, parts.path), ("https", "itunes.apple.com", "/search"))
        params = urllib.parse.parse_qs(parts.query)
        self.assertEqual(params, {"term": [query], "country": ["in"], "media": ["software"],
                                  "entity": ["software"], "limit": ["3"]})
        self.assertNotIn("com.private.secret", url)
        self.assertNotIn(UDID, url)
        self.assertEqual(self.runner.calls, [])
        row = result["candidates"][0]
        self.assertEqual(row, {"name": "Expense Tracker", "bundle_id": "com.example.expenses", "aliases": [],
                               "publisher": "Example Ltd", "origin": "apple", "installed_verified": False,
                               "installation_checked": False,
                               "store_url": "https://apps.apple.com/in/app/id1234567890", "track_id": 1234567890,
                               "country": "in"})
        self.assertEqual(result["searched_sources"], ["apple"])
        cache = os.path.join(self.state, "apps-apple-cache.json")
        self.assertEqual(stat.S_IMODE(os.stat(cache).st_mode), 0o600)
        times = os.path.join(self.state, "apps-apple-request-times.json")
        self.assertEqual(stat.S_IMODE(os.stat(times).st_mode), 0o600)
        self.assertEqual(len(privstate.read_json(times)), 1)

    def test_apple_cache_expires_after_fifteen_minutes(self):
        fetch = Fetcher()
        catalog = self.catalog(fetch=fetch)
        clock = FakeClock(start=80000.0)
        with mock.patch.object(wda_apps, "time", clock):
            catalog.lookup("expense", source="apple")
            clock.advance(899)
            catalog.lookup("expense", source="apple")
            self.assertEqual(len(fetch.urls), 1)
            clock.advance(2)
            catalog.lookup("expense", source="apple")
            self.assertEqual(len(fetch.urls), 2)

    def test_auto_uses_apple_once_only_when_nothing_local_matched(self):
        self.device_apps()
        fetch = Fetcher()
        catalog = self.catalog(fetch=fetch, udid=UDID)
        result = catalog.lookup("Expense Tracker")
        self.assertEqual(len(fetch.urls), 1)
        self.assertEqual(result["searched_sources"], ["installed", "catalog", "apple"])
        self.assertEqual([row["bundle_id"] for row in result["candidates"]], ["com.example.expenses"])
        self.assertTrue(result["candidates"][0]["installation_checked"])
        self.assertFalse(result["candidates"][0]["installed_verified"])
        local = catalog.lookup("WhatsApp")
        self.assertEqual(len(fetch.urls), 1)
        self.assertEqual(local["searched_sources"], ["installed", "catalog"])

    def test_rate_budget_blocks_without_a_request(self):
        clock = FakeClock(start=90000.0)
        privstate.write_json_private(os.path.join(self.state, "apps-apple-request-times.json"),
                                     [89990.0] * 18)
        catalog = self.catalog(fetch=offline)
        with mock.patch.object(wda_apps, "time", clock):
            error = self.lookup_error(catalog, "expense", source="apple")
            self.assertEqual(error.code, "app_lookup_unavailable")
            self.assertEqual(error.details["warnings"], [wda_apps.BUDGET_WARNING])
            self.assertIn("budget", error.message)
            clock.advance(61)  # the old requests have left the 60 s window
            fetch = Fetcher()
            catalog.fetch = fetch
            catalog.lookup("expense", source="apple")
        self.assertEqual(len(fetch.urls), 1)
        self.assertEqual(privstate.read_json(os.path.join(self.state, "apps-apple-request-times.json")), [90061.0])

    def test_failures_are_errors_but_an_empty_success_is_not(self):
        catalog = self.catalog(fetch=Fetcher(error=OSError("offline")))
        error = self.lookup_error(catalog, "A missing app", source="apple")
        self.assertEqual(error.code, "app_lookup_unavailable")
        self.assertEqual(error.message, wda_apps.APPLE_FAILED_WARNING)
        self.assertFalse(error.uncertain)
        self.assertEqual(error.details["candidates"], [])
        self.assertEqual(error.details["searched_sources"], ["apple"])
        error = self.lookup_error(catalog, "Another missing app")
        self.assertEqual(error.details["searched_sources"], ["installed", "catalog", "apple"])
        self.assertEqual(error.details["warnings"], [wda_apps.NO_DEVICE_WARNING, wda_apps.APPLE_FAILED_WARNING])
        self.assertEqual(error.message, wda_apps.NO_DEVICE_WARNING + "; " + wda_apps.APPLE_FAILED_WARNING)
        throttled = self.catalog(fetch=Fetcher(error=urllib.error.HTTPError(
            "https://itunes.apple.com/search", 429, "Too Many Requests", {}, None)))
        error = self.lookup_error(throttled, "Throttled app", source="apple")
        self.assertEqual(error.details["warnings"], [wda_apps.THROTTLED_WARNING])
        weird = self.catalog(fetch=Fetcher(document={"results": "nope"}))
        self.assertEqual(self.lookup_error(weird, "Weird app", source="apple").details["warnings"],
                         [wda_apps.APPLE_FAILED_WARNING])
        empty = self.catalog(fetch=Fetcher(document={"results": []}))
        result = empty.lookup("Different absent app", source="apple")
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["warnings"], [])
        result = empty.lookup("Auto absent app")
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["warnings"], [wda_apps.NO_DEVICE_WARNING])
        self.assertEqual(result["total_matches"], 0)

    def test_default_country_and_overrides(self):
        fetch = Fetcher()
        catalog = self.catalog(fetch=fetch)
        self.assertEqual(catalog.lookup("expense", source="apple")["country"], "in")
        privstate.write_json_private(os.path.join(self.state, "config.json"), {"app_store_country": "US"})
        self.assertEqual(catalog.lookup("expense", source="apple")["country"], "us")
        self.assertEqual(catalog.lookup("expense", country="GB", source="apple")["country"], "gb")
        privstate.write_json_private(os.path.join(self.state, "config.json"), {"app_store_country": "nowhere"})
        self.assertEqual(catalog.lookup("Notes", source="catalog")["country"], "in")
        countries = [urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["country"][0] for url in fetch.urls]
        self.assertEqual(countries, ["in", "us", "gb"])
        self.assertEqual(wda_apps.DEFAULT_COUNTRY, "in")

    def test_url_allowlist_and_redirects(self):
        allowed = ("https://itunes.apple.com/search?term=x", "https://itunes.apple.com:443/lookup?id=1")
        for url in allowed:
            self.assertTrue(wda_apps.api_url_allowed(url), url)
        rejected = ("http://itunes.apple.com/search", "https://example.com/search",
                    "https://itunes.apple.com.evil.test/search", "https://user:password@itunes.apple.com/search",
                    "https://itunes.apple.com/search#fragment", "https://itunes.apple.com:8443/search",
                    "https://itunes.apple.com/other", "https://itunes.apple.com:99999/search", "")
        for url in rejected:
            with self.subTest(url=url):
                self.assertFalse(wda_apps.api_url_allowed(url))
                with self.assertRaises(ValueError):
                    wda_apps.fetch_apple(url)
        with self.assertRaises(ValueError):
            wda_apps.AppleRedirectHandler().redirect_request(None, None, 302, "", {}, "https://example.com/search")

    def test_fetch_apple_checks_the_answer(self):
        class Response(io.BytesIO):
            def __init__(self, data, url):
                super().__init__(data)
                self.url = url

            def geturl(self):
                return self.url

            def __enter__(self):
                return self

            def __exit__(self, *ignored):
                self.close()
                return False

        class Opener:
            def __init__(self, response):
                self.response = response
                self.requests = []

            def open(self, request, timeout=None):
                self.requests.append((request, timeout))
                return self.response

        url = "https://itunes.apple.com/search?term=x"
        good = Opener(Response(json.dumps(APPLE).encode(), url))
        with mock.patch.object(wda_apps.urllib.request, "build_opener", return_value=good) as build:
            self.assertEqual(wda_apps.fetch_apple(url), APPLE)
        handlers = build.call_args[0]
        self.assertTrue(any(isinstance(handler, wda_apps.AppleRedirectHandler) for handler in handlers))
        request, timeout = good.requests[0]
        self.assertEqual(timeout, 5.0)
        self.assertEqual(request.get_header("Accept"), "application/json")
        bad_answers = (
            Response(json.dumps(APPLE).encode(), "https://example.com/search"),
            Response(b"x" * (wda_apps.MAX_RESPONSE_BYTES + 1), url),
            Response(b"[1, 2]", url),
            Response(b'{"results": {}}', url),
            Response(b"\xff\xfe not json", url),
        )
        for response in bad_answers:
            with self.subTest(size=len(response.getvalue())):
                with mock.patch.object(wda_apps.urllib.request, "build_opener", return_value=Opener(response)):
                    with self.assertRaises(ValueError):
                        wda_apps.fetch_apple(url)


class ArgumentTests(AppsCase):
    def test_input_bounds(self):
        catalog = self.catalog()
        cases = [({"query": ""}, "query"), ({"query": "   "}, "query"), ({"query": "x" * 101}, "query"),
                 ({"query": 5}, "query"), ({"query": "x", "country": "ind"}, "country"),
                 ({"query": "x", "country": "1n"}, "country"), ({"query": "x", "country": "üs"}, "country"),
                 ({"query": "x", "source": "shell"}, "source"), ({"query": "x", "limit": True}, "limit"),
                 ({"query": "x", "limit": 0}, "limit"), ({"query": "x", "limit": 31}, "limit"),
                 ({"query": "x", "limit": "5"}, "limit")]
        for kwargs, name in cases:
            with self.subTest(kwargs=kwargs):
                error = self.lookup_error(catalog, **kwargs)
                self.assertEqual(error.code, "invalid_argument")
                self.assertEqual(error.details["argument_path"], "arguments." + name)
                self.assertIs(error.details["action_executed"], False)
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(catalog.lookup(" " + "x" * 100 + " ", source="catalog")["query"], "x" * 100)

    def test_signature_defaults(self):
        parameters = inspect.signature(wda_apps.AppCatalog.lookup).parameters
        self.assertIsNone(parameters["country"].default)
        self.assertEqual(parameters["source"].default, "auto")
        self.assertEqual(parameters["limit"].default, 10)

    def test_state_inside_git_is_rejected(self):
        root = os.path.join(self.tmp, "repo")
        os.makedirs(os.path.join(root, ".git"))
        with self.assertRaises(ToolError) as caught:
            wda_apps.AppCatalog(os.path.join(root, "state"), runner=self.runner, fetch=offline)
        self.assertEqual(caught.exception.code, "state_dir_unsafe")

    def test_messages_name_real_tools_only(self):
        names = {"iphone_setup", "iphone_launch_app"}
        texts = [wda_apps.NEXT_ACTION, wda_apps.NO_DEVICE_WARNING, wda_apps.LIST_FAILED_WARNING,
                 wda_apps.LIST_UNAVAILABLE_WARNING, wda_apps.BUDGET_WARNING, wda_apps.THROTTLED_WARNING,
                 wda_apps.APPLE_FAILED_WARNING]
        for text in texts:
            for token in re.findall(r"\biphone_[a-z][a-z_]*", text):
                self.assertIn(token, names)


if __name__ == "__main__":
    unittest.main()
