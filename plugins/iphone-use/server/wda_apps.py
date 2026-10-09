"""Find an app's real bundle ID by name (the iphone_apps tool).

Sources, in order:

1. the chosen iPhone's installed apps (``xcrun devicectl device info apps --include-all-apps``),
   cached privately for 5 minutes. Only matching rows ever leave this module, and the
   inventory is never sent anywhere;
2. a bundled list of Apple built-in apps and well-known global apps (``apps_catalog.json``);
3. Apple's public App Store search, only when nothing local matched (or ``source="apple"``),
   with a cache, a shared request budget and a strict HTTPS allowlist.

A catalog or store entry never proves an app is installed; ``installed_verified`` does.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import cmdrunner
import privstate
from errors import ToolError
from privstate import FileLock

CATALOG_PATH = pathlib.Path(__file__).resolve().parent / "apps_catalog.json"
INSTALLED_TTL = 300
APPLE_TTL = 900
APPLE_BUDGET = 18
APPLE_WINDOW = 60
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
APPLE_TIMEOUT = 5.0
DEFAULT_COUNTRY = "in"
BUNDLE_RE = r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+"
UDID_RE = r"[A-Za-z0-9-]{8,64}"
SOURCES = ("auto", "installed", "catalog", "apple")
APPLE_HOST = "itunes.apple.com"
APPLE_PATHS = ("/search", "/lookup")
USER_AGENT = "iphone-use app lookup"
DEVICECTL_TIMEOUT = 10

NEXT_ACTION = ("Pick the right app and publisher, then call iphone_launch_app with its bundle_id. A store or catalog "
               "entry does not prove the app is installed; check installed_verified.")
NO_DEVICE_WARNING = ("No iPhone is selected yet. Run iphone_setup(action=\"configure\") first, then retry "
                     "source=installed.")
LIST_FAILED_WARNING = ("Could not list the iPhone's apps. Unlock the iPhone, check that it is connected and that "
                       "Xcode can see it, then retry; catalog entries do not prove an app is installed.")
LIST_UNAVAILABLE_WARNING = ("Listing the iPhone's apps timed out or Xcode's devicectl is unavailable. Check Xcode and "
                            "the iPhone connection; catalog entries do not prove an app is installed.")
BUDGET_WARNING = ("Apple App Store search budget reached (18 searches a minute). Use source=installed or catalog, "
                  "or retry in a minute.")
THROTTLED_WARNING = ("Apple's App Store search refused or throttled the request. Do not retry repeatedly; use "
                     "source=installed or catalog.")
APPLE_FAILED_WARNING = ("Apple's App Store search failed or timed out. Try source=installed or catalog, or another "
                        "country; never guess bundle IDs.")

_BUNDLE = re.compile(BUNDLE_RE)
_UDID = re.compile(UDID_RE)
_COUNTRY = re.compile(r"[A-Za-z]{2}")
_OUTPUT_EXTRAS = ("store_url", "track_id", "country")


def normalize(value) -> str:
    """Case- and space-insensitive form used for matching."""
    return " ".join(str(value).casefold().split())


def valid_bundle(value) -> bool:
    return isinstance(value, str) and len(value) <= 200 and bool(_BUNDLE.fullmatch(value))


def api_url_allowed(url) -> bool:
    """True only for https://itunes.apple.com/search or /lookup (no credentials, port 443, no fragment)."""
    try:
        parts = urllib.parse.urlsplit(str(url))
        port = parts.port
    except ValueError:
        return False
    return (parts.scheme == "https" and parts.hostname == APPLE_HOST and parts.username is None
            and parts.password is None and port in (None, 443) and parts.path in APPLE_PATHS
            and not parts.fragment)


class AppleRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only when the new URL is still an allowed Apple API URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not api_url_allowed(newurl):
            raise ValueError("Apple's App Store search redirected outside the allowed HTTPS API.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_apple(url) -> dict:
    """GET an Apple search/lookup URL and return its JSON object (5 s timeout, 2 MiB cap)."""
    if not api_url_allowed(url):
        raise ValueError("Only https://itunes.apple.com/search or /lookup is allowed.")
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    opener = urllib.request.build_opener(AppleRedirectHandler())
    with opener.open(request, timeout=APPLE_TIMEOUT) as response:
        if not api_url_allowed(response.geturl()):
            raise ValueError("Apple's App Store search answered from an unexpected URL.")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("Apple's App Store search answer was too large.")
    document = json.loads(raw.decode("utf-8"))
    if not isinstance(document, dict) or not isinstance(document.get("results"), list):
        raise ValueError("Apple's App Store search returned an unexpected answer.")
    return document


def parse_apple(document, country) -> list:
    """Software results with a valid bundle ID, name and track ID; promotional fields are dropped."""
    rows, seen = [], set()
    results = document.get("results") if isinstance(document, dict) else None
    for app in results if isinstance(results, list) else []:
        if not isinstance(app, dict) or app.get("kind") not in (None, "software"):
            continue
        bundle, name, track_id = app.get("bundleId"), app.get("trackName"), app.get("trackId")
        if not valid_bundle(bundle) or not isinstance(name, str) or not name.strip():
            continue
        if isinstance(track_id, bool) or not isinstance(track_id, int) or track_id <= 0:
            continue
        if bundle in seen:
            continue
        seen.add(bundle)
        publisher = app.get("artistName")
        rows.append({
            "name": name.strip()[:200],
            "aliases": [],
            "bundle_id": bundle,
            "publisher": publisher.strip()[:200] if isinstance(publisher, str) and publisher.strip() else None,
            "store_name": name.strip()[:200],
            "origin": "apple",
            "store_url": "https://apps.apple.com/%s/app/id%d" % (country, track_id),
            "track_id": track_id,
            "country": country,
        })
    return rows


def parse_installed(document) -> list:
    """Installed apps from `devicectl device info apps` JSON (an `apps` list or an `installedApps` dict)."""
    result = document.get("result") if isinstance(document, dict) else None
    result = result if isinstance(result, dict) else {}
    apps = result.get("apps", result.get("installedApps"))
    if isinstance(apps, dict):
        apps = [dict(value, bundleIdentifier=key) for key, value in apps.items() if isinstance(value, dict)]
    rows, seen = [], set()
    for app in apps if isinstance(apps, list) else []:
        if not isinstance(app, dict):
            continue
        bundle = app.get("bundleIdentifier", app.get("bundleId", app.get("bundleID")))
        name = app.get("name", app.get("displayName", bundle))
        if not valid_bundle(bundle) or bundle in seen:
            continue
        if not isinstance(name, str) or not name.strip():
            name = bundle
        seen.add(bundle)
        rows.append({"name": name.strip()[:200], "bundle_id": bundle})
    return rows


def _installed_list_present(document) -> bool:
    result = document.get("result") if isinstance(document, dict) else None
    if not isinstance(result, dict):
        return False
    return isinstance(result.get("apps"), (list, dict)) or isinstance(result.get("installedApps"), (list, dict))


def load_catalog(path) -> list:
    """Rows of the bundled catalog; entries without a valid bundle ID or name are skipped."""
    document = privstate.read_json(path, {})
    apps = document.get("apps") if isinstance(document, dict) else None
    rows, seen = [], set()
    for app in apps if isinstance(apps, list) else []:
        if not isinstance(app, dict):
            continue
        bundle, name = app.get("bundleId"), app.get("name")
        if not valid_bundle(bundle) or bundle in seen or not isinstance(name, str) or not name.strip():
            continue
        seen.add(bundle)
        aliases = [alias for alias in app.get("aliases", []) if isinstance(alias, str) and alias.strip()]
        publisher = app.get("publisher")
        rows.append({
            "name": name.strip(),
            "aliases": aliases,
            "bundle_id": bundle,
            "publisher": publisher if isinstance(publisher, str) and publisher.strip() else None,
            "origin": "catalog",
        })
    return rows


def _score(row, query) -> int:
    """2 for an exact (normalized) name/alias/bundle match, 1 for a substring match, else 0."""
    target = normalize(query)
    values = [normalize(value) for value in (row.get("name") or "", row.get("store_name") or "", row["bundle_id"],
                                             *(row.get("aliases") or []))]
    if target in values:
        return 2
    return 1 if any(target in value for value in values if value) else 0


def _public_row(row) -> dict:
    result = {"name": row["name"], "bundle_id": row["bundle_id"], "aliases": list(row.get("aliases") or [])}
    if row.get("publisher"):
        result["publisher"] = row["publisher"]
    result["origin"] = row["origin"]
    result["installed_verified"] = bool(row.get("installed_verified"))
    result["installation_checked"] = bool(row.get("installation_checked"))
    for key in _OUTPUT_EXTRAS:
        if row.get(key) is not None:
            result[key] = row[key]
    return result


def _argument_error(name, message) -> ToolError:
    return ToolError("invalid_argument", message, details={"action_executed": False,
                                                           "argument_path": "arguments." + name})


class AppCatalog:
    """Bundle-ID lookup over the installed apps, the bundled catalog and Apple's App Store search."""

    def __init__(self, state_dir, runner=None, fetch=None, catalog_path=CATALOG_PATH):
        self.state_dir = privstate.prepare_state_dir(state_dir)
        self.runner = runner if runner is not None else cmdrunner.run_command
        self.fetch = fetch if fetch is not None else fetch_apple
        self.catalog_path = pathlib.Path(catalog_path)
        self._catalog = None

    # -- arguments --

    @staticmethod
    def _check_arguments(query, country, source, limit):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 100:
            raise _argument_error("query", "query must be 1 to 100 characters, such as Notes or WhatsApp.")
        if country is not None and (not isinstance(country, str) or not _COUNTRY.fullmatch(country)):
            raise _argument_error("country", "country must be a two-letter App Store country code such as in or us.")
        if source not in SOURCES:
            raise _argument_error("source", "source must be auto, installed, catalog or apple.")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 30:
            raise _argument_error("limit", "limit must be a whole number from 1 to 30.")
        return query.strip(), (country.lower() if country else None), source, limit

    def _catalog_rows(self) -> list:
        if self._catalog is None:
            self._catalog = load_catalog(self.catalog_path)
        return [dict(row, aliases=list(row["aliases"])) for row in self._catalog]

    # -- installed apps --

    def _installed(self, config):
        """(rows, installation_checked, warning) for the configured iPhone; no command without a valid udid."""
        udid = config.get("udid")
        if not isinstance(udid, str) or not _UDID.fullmatch(udid):
            return [], False, NO_DEVICE_WARNING
        device_key = hashlib.sha256(udid.encode("utf-8")).hexdigest()
        cache_path = self.state_dir / "apps-installed-cache.json"
        cache = privstate.read_json(cache_path, {})
        if isinstance(cache, dict) and cache.get("device_key") == device_key and isinstance(cache.get("apps"), list):
            fetched = cache.get("fetched_at")
            if (isinstance(fetched, (int, float)) and not isinstance(fetched, bool)
                    and 0 <= time.time() - fetched < INSTALLED_TTL):
                rows = [{"name": row["name"], "bundle_id": row["bundle_id"]} for row in cache["apps"]
                        if isinstance(row, dict) and valid_bundle(row.get("bundle_id"))
                        and isinstance(row.get("name"), str)]
                return rows, True, None
        fd, temp_path = tempfile.mkstemp(prefix="apps-device-", suffix=".json", dir=str(self.state_dir))
        os.close(fd)
        try:
            # --include-all-apps is essential: without it devicectl lists only developer apps.
            argv = ["xcrun", "devicectl", "device", "info", "apps", "--device", udid, "--include-all-apps",
                    "--json-output", temp_path, "--timeout", "8"]
            try:
                result = self.runner(argv, timeout=DEVICECTL_TIMEOUT)
            except Exception:
                result = cmdrunner.CommandResult(127, "", "")
            document = privstate.read_json(temp_path, None)
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
        if result.returncode in (124, 127):
            return [], False, LIST_UNAVAILABLE_WARNING
        if result.returncode != 0 or not _installed_list_present(document):
            return [], False, LIST_FAILED_WARNING
        rows = parse_installed(document)
        privstate.write_json_private(cache_path, {"device_key": device_key, "fetched_at": time.time(), "apps": rows})
        return rows, True, None

    @staticmethod
    def _enrich(row, reference) -> dict:
        """An installed row with the catalog's aliases, name and publisher for matching."""
        enriched = {"name": row["name"], "bundle_id": row["bundle_id"], "aliases": [], "origin": "installed"}
        if reference:
            names = list(reference.get("aliases") or []) + [reference.get("name") or ""]
            seen = {normalize(row["name"])}
            for alias in names:
                key = normalize(alias)
                if key and key not in seen:
                    seen.add(key)
                    enriched["aliases"].append(alias)
            if reference.get("publisher"):
                enriched["publisher"] = reference["publisher"]
        return enriched

    # -- Apple search --

    def _apple(self, query, country, limit):
        """(rows, warning) from Apple's search, using the cache and the shared request budget."""
        url = "https://itunes.apple.com/search?" + urllib.parse.urlencode(
            [("term", query), ("country", country), ("media", "software"), ("entity", "software"),
             ("limit", str(limit))])
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        cache_path = self.state_dir / "apps-apple-cache.json"
        cache = privstate.read_json(cache_path, {})
        cache = cache if isinstance(cache, dict) else {}
        entry = cache.get(key)
        if self._fresh(entry):
            return [row for row in entry["apps"] if isinstance(row, dict) and valid_bundle(row.get("bundle_id"))], None
        with FileLock(self.state_dir / ".apps-apple.lock"):
            times_path = self.state_dir / "apps-apple-request-times.json"
            stamps = privstate.read_json(times_path, [])
            now = time.time()
            stamps = [stamp for stamp in (stamps if isinstance(stamps, list) else [])
                      if isinstance(stamp, (int, float)) and not isinstance(stamp, bool)
                      and 0 <= now - stamp < APPLE_WINDOW]
            if len(stamps) >= APPLE_BUDGET:
                return [], BUDGET_WARNING
            privstate.write_json_private(times_path, stamps + [now])
        try:
            document = self.fetch(url)
            if not isinstance(document, dict) or not isinstance(document.get("results"), list):
                raise ValueError("unexpected answer")
            rows = parse_apple(document, country)
        except urllib.error.HTTPError as exc:
            return [], THROTTLED_WARNING if exc.code in (403, 429) else APPLE_FAILED_WARNING
        except Exception:  # network, TLS, JSON or redirect problems all mean "unavailable"
            return [], APPLE_FAILED_WARNING
        cache = privstate.read_json(cache_path, {})
        cache = {cache_key: value for cache_key, value in (cache.items() if isinstance(cache, dict) else [])
                 if self._fresh(value)}
        cache[key] = {"fetched_at": time.time(), "apps": rows}
        privstate.write_json_private(cache_path, cache)
        return rows, None

    @staticmethod
    def _fresh(entry) -> bool:
        if not isinstance(entry, dict) or not isinstance(entry.get("apps"), list):
            return False
        fetched = entry.get("fetched_at")
        return (isinstance(fetched, (int, float)) and not isinstance(fetched, bool)
                and 0 <= time.time() - fetched < APPLE_TTL)

    # -- the lookup --

    def lookup(self, query, country=None, source="auto", limit=10) -> dict:
        """Candidates for an app name; installed apps first, Apple only when nothing local matched."""
        query, country, source, limit = self._check_arguments(query, country, source, limit)
        config = privstate.read_config(self.state_dir)
        if country is None:
            configured = config.get("app_store_country")
            country = configured.lower() if isinstance(configured, str) and _COUNTRY.fullmatch(configured) \
                else DEFAULT_COUNTRY
        catalog = self._catalog_rows()
        by_bundle = {row["bundle_id"]: row for row in catalog}
        warnings, searched, candidates = [], [], []
        installed, checked = [], False
        if source in ("auto", "installed"):
            searched.append("installed")
            installed, checked, warning = self._installed(config)
            if warning:
                warnings.append(warning)
            for row in installed:
                enriched = self._enrich(row, by_bundle.get(row["bundle_id"]))
                if _score(enriched, query):
                    candidates.append(enriched)
        if source in ("auto", "catalog"):
            searched.append("catalog")
            candidates.extend(row for row in catalog if _score(row, query))
        apple_error = None
        if source == "apple" or (source == "auto" and not candidates):
            searched.append("apple")
            rows, apple_error = self._apple(query, country, limit)
            candidates.extend(rows)
            if apple_error:
                warnings.append(apple_error)
        installed_ids = {row["bundle_id"] for row in installed}
        merged = {}
        for row in candidates:
            row = dict(row)
            row["installation_checked"] = checked
            row["installed_verified"] = checked and row["bundle_id"] in installed_ids
            existing = merged.get(row["bundle_id"])
            if existing is None:
                merged[row["bundle_id"]] = row
                continue
            for key, value in row.items():
                if existing.get(key) in (None, "", []):
                    existing[key] = value
        ranked = sorted(merged.values(), key=lambda item: (-_score(item, query), -int(item["installed_verified"]),
                                                            item["name"], item["bundle_id"]))
        exact = [row for row in ranked if _score(row, query) == 2]
        if exact:
            ranked = exact
        public = [_public_row(row) for row in ranked[:limit]]
        if (source == "installed" and not checked) or (apple_error and not ranked):
            raise ToolError("app_lookup_unavailable", "; ".join(warnings) or "App lookup could not be completed.",
                            details={"candidates": public, "searched_sources": searched, "warnings": warnings,
                                     "action_executed": False})
        return {"query": query, "country": country, "source": source, "candidates": public,
                "total_matches": len(ranked), "searched_sources": searched, "warnings": warnings,
                "next_action": NEXT_ACTION}
