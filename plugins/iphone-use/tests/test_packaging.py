import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Packaging checks: manifests, skills, documentation, licenses, CI workflow and Python 3.9 grammar.

import ast
import json
import re
import stat
import subprocess
import unittest
from pathlib import Path

PLUGIN = Path(HERE).resolve().parent
REPO = PLUGIN.parents[1]
# The repository-level files (marketplace, root README, CI workflow) exist only in the da-one checkout, not in an
# installed copy of the plugin.
IN_REPO = (REPO / "plugins" / "iphone-use").resolve() == PLUGIN

TOOL_NAMES = (
    "iphone_doctor", "iphone_setup", "iphone_ready", "iphone_observe", "iphone_find", "iphone_apps",
    "iphone_launch_app", "iphone_tap", "iphone_swipe", "iphone_press_button", "iphone_type_text", "iphone_wait",
    "iphone_batch", "iphone_scroll_find", "iphone_collect_list", "iphone_screen", "iphone_metrics",
)
ERROR_CODES = (
    "service_unreachable", "action_uncertain", "response_too_large", "invalid_response", "http_error",
    "invalid_argument", "invalid_selector", "unknown_tool", "newline_requires_intent", "newline_unsafe",
    "submit_unsafe", "stale_observation", "foreground_unavailable", "no_such_element", "ambiguous_target",
    "occluded_target", "offscreen_target", "not_editable", "no_focused_field", "search_exhausted",
    "no_scroll_progress", "scroll_context_changed", "modal_requires_region", "blocked_scroll_region",
    "postcondition_failed", "input_mismatch", "input_continuation_expired", "device_busy", "phone_locked",
    "not_ready", "mirroring_conflict", "recovery_not_started", "internal_error", "config_invalid",
    "config_choice_required", "prerequisite_missing", "job_conflict", "unknown_job", "state_dir_unsafe",
    "setup_failed", "app_lookup_unavailable",
)
RAW_WDA_ERRORS = (
    "invalid session id", "no such element", "stale element reference", "element not interactable",
    "element click intercepted", "invalid element state", "unknown error", "invalid argument",
)
FULL_NAME_PREFIX = "mcp__plugin_iphone-use_iphone__"
READ_ONLY_ALLOWLIST = (
    "iphone_ready", "iphone_observe", "iphone_find", "iphone_wait", "iphone_apps", "iphone_screen",
    "iphone_doctor", "iphone_metrics",
)

SKILL_REFERENCES = {
    "iphone-use": {
        "tools.md", "startup.md", "screen-reading.md", "failures.md", "typing-and-sending.md",
        "lists-and-scrolling.md", "authentication.md", "verification.md", "preview.md", "apps.md",
        "cli-fallback.md",
    },
    "iphone-use-setup": {"first-time-setup.md", "recovery.md", "troubleshooting.md"},
}
SKILL_FRONTMATTER = {
    "iphone-use": {
        "name": "iphone-use",
        "description": (
            "Operate the user's real iPhone, connected to this Mac by USB, with the iPhone Use tools - open apps, "
            "read the screen, tap, scroll, type, collect lists and check key results. Use for any request to do, "
            "find, read or send something on the user's iPhone."
        ),
        "when_to_use": (
            "The user asks to do something on their iPhone or in an iPhone app (read messages, check a bank or "
            "brokerage app, fill a form, change a setting, find information), or mentions the live iPhone preview."
        ),
    },
    "iphone-use-setup": {
        "name": "iphone-use-setup",
        "description": (
            "Set up or reconnect iPhone Use - install and sign the on-iPhone helper (WebDriverAgent) with Xcode, "
            "start it, and fix USB, trust, Developer Mode, signing or connection problems. Use for first-time "
            "setup, when iphone_ready says the service is not running or needs recovery, when the weekly "
            "free-account signature has expired, or when the user asks to connect their iPhone."
        ),
    },
}
SKILL_LINE_LIMITS = {"iphone-use": 300, "iphone-use-setup": 250}

EXPECTED_MARKETPLACE = {
    "name": "da-one",
    "owner": {"name": "subcinctus"},
    "metadata": {"description": "Claude Code plugins from the da-one repository."},
    "plugins": [{
        "name": "iphone-use",
        "source": "./plugins/iphone-use",
        "description": ("Let Claude operate your real iPhone over USB: open apps, read the screen, tap, type and "
                        "check results, with a live preview."),
        "version": "0.1.0",
        "category": "productivity",
    }],
}
EXPECTED_PLUGIN = {
    "name": "iphone-use",
    "version": "0.1.0",
    "description": ("Let Claude operate your real iPhone over USB through WebDriverAgent: guided setup, app "
                    "automation, a live screen preview and screenshot fallback."),
    "author": {"name": "subcinctus"},
    "homepage": "https://github.com/subcinctus/da-one",
    "repository": "https://github.com/subcinctus/da-one",
    "license": "MIT",
    "keywords": ["iphone", "ios", "automation", "webdriveragent", "mobile"],
}
EXPECTED_MCP = {
    "mcpServers": {
        "iphone": {
            "command": "python3",
            "args": ["${CLAUDE_PLUGIN_ROOT}/server/iphone_use.py"],
            "env": {"PYTHONDONTWRITEBYTECODE": "1"},
        },
    },
}
EXPECTED_AUTH_QUESTION = {"questions": [{
    "question": ("Your banking app is asking for Face ID. Please complete it on your iPhone and stay on the "
                 "accounts page. When you're done, choose \"Done, continue\" and I'll read the remaining "
                 "transactions."),
    "header": "Face ID",
    "multiSelect": False,
    "options": [
        {"label": "Done, continue", "description": "I finished it on my iPhone"},
        {"label": "I can't do this now", "description": "Stop phone steps and keep what you have so far"},
    ],
}]}

# Codex-only constructs that must never appear in the skills or the READMEs (case-sensitive substrings).
CODEX_TOKENS = ("functions.exec", "view_image", "request_user_input", "pua_", "${PLUGIN_ROOT}", ".codex-plugin")
CODEX_TOKENS_ANY_CASE = ("side panel", "sidebar", "widget")
CJK_RE = re.compile(
    "[ᄀ-ᇿ⺀-⿟　-〿぀-ヿ㄀-ㄯ㄰-㆏ㆠ-ㇿ"
    "㈀-㋿㌀-㏿㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿"
    "︰-﹏＀-￯\U00020000-\U0002fa1f]"
)
TOOL_TOKEN_RE = re.compile(r"\biphone_[a-z][a-z_]*")
FULL_NAME_RE = re.compile(r"mcp__plugin_iphone-use_iphone__(\*|iphone_<name>|[A-Za-z0-9_]*)")
LINK_RE = re.compile(r"\[[^\]\n]*\]\(([^)\s]+)\)")
FENCE_RE = re.compile(r"^\s*```")


def read(path):
    return Path(path).read_text(encoding="utf-8")


def flat(text):
    """Text with Markdown bold markers removed and all whitespace runs collapsed (ignores line wrapping)."""
    return " ".join(text.replace("**", "").split())


def skill_docs():
    return sorted((PLUGIN / "skills").rglob("*.md"))


def readmes():
    docs = [PLUGIN / "README.md"]
    if IN_REPO:
        docs.append(REPO / "README.md")
    return docs


def unit_docs():
    """Every Markdown/text document this unit writes."""
    return skill_docs() + readmes() + [PLUGIN / "THIRD_PARTY_NOTICES.md", PLUGIN / "CHANGELOG.md",
                                       PLUGIN / "LICENSE"]


def strip_code_blocks(text):
    """Return the text with fenced code blocks blanked out (line count preserved)."""
    out, inside = [], False
    for line in text.splitlines():
        if FENCE_RE.match(line):
            inside = not inside
            out.append("")
            continue
        out.append("" if inside else line)
    return "\n".join(out)


def code_blocks(text, language=None):
    blocks, current, inside, lang = [], [], False, ""
    for line in text.splitlines():
        if FENCE_RE.match(line):
            if inside:
                if language is None or lang == language:
                    blocks.append("\n".join(current))
                current, inside = [], False
            else:
                inside, lang = True, line.strip()[3:].strip()
            continue
        if inside:
            current.append(line)
    return blocks


def split_row(line):
    cells = line.strip()
    if cells.startswith("|"):
        cells = cells[1:]
    if cells.endswith("|"):
        cells = cells[:-1]
    return [cell.strip() for cell in cells.split("|")]


def markdown_tables(text):
    """[(header_line, header_cells, body_rows)] for every pipe table outside code blocks."""
    lines = strip_code_blocks(text).splitlines()
    separator = re.compile(r"^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$")
    tables, index = [], 0
    while index < len(lines):
        line = lines[index]
        if line.lstrip().startswith("|") and index + 1 < len(lines) and separator.match(lines[index + 1]):
            rows, body = [], index + 2
            while body < len(lines) and lines[body].lstrip().startswith("|"):
                rows.append(split_row(lines[body]))
                body += 1
            tables.append((line.strip(), split_row(line), rows))
            index = body
        else:
            index += 1
    return tables


def frontmatter(path):
    text = read(path)
    if not text.startswith("---\n"):
        raise AssertionError("%s has no frontmatter" % path)
    end = text.index("\n---\n", 4)
    fields = {}
    for line in text[4:end].splitlines():
        if not line.strip():
            continue
        key, sep, value = line.partition(": ")
        if not sep:
            raise AssertionError("%s frontmatter line is not 'key: value': %r" % (path, line))
        fields[key] = value
    return fields, text[end + 5:]


def doc_items(text):
    """Split a document into bullet items, table rows and paragraphs (code blocks removed)."""
    items, current = [], []
    for line in strip_code_blocks(text).splitlines():
        stripped = line.strip()
        starts_item = bool(re.match(r"(-|\*|\||\d+\.)\s", stripped)) or stripped.startswith("#")
        if not stripped or starts_item:
            if current:
                items.append(" ".join(current))
            current = [stripped] if stripped else []
        else:
            current.append(stripped)
    if current:
        items.append(" ".join(current))
    return items


def section(text, heading_prefix):
    """The body of the first Markdown section whose heading starts with heading_prefix."""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"(#+)\s+(.*)", line)
        if match and match.group(2).startswith(heading_prefix):
            level = len(match.group(1))
            body = []
            for other in lines[index + 1:]:
                other_match = re.match(r"(#+)\s", other)
                if other_match and len(other_match.group(1)) <= level:
                    break
                body.append(other)
            return "\n".join(body)
    raise AssertionError("no section starting with %r" % heading_prefix)


def rel(path):
    try:
        return str(Path(path).relative_to(REPO))
    except ValueError:
        return str(path)


class ManifestTests(unittest.TestCase):
    def load(self, path):
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    @unittest.skipUnless(IN_REPO, "repository files are not part of an installed plugin")
    def test_marketplace_manifest_is_exact(self):
        marketplace = self.load(REPO / ".claude-plugin" / "marketplace.json")
        self.assertEqual(marketplace, EXPECTED_MARKETPLACE)
        entry = marketplace["plugins"][0]
        self.assertEqual(entry["name"], "iphone-use")
        self.assertEqual((REPO / entry["source"]).resolve(), PLUGIN)
        self.assertTrue((PLUGIN / ".claude-plugin" / "plugin.json").is_file())

    def test_plugin_manifest_is_exact(self):
        plugin = self.load(PLUGIN / ".claude-plugin" / "plugin.json")
        self.assertEqual(plugin, EXPECTED_PLUGIN)
        self.assertRegex(plugin["version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(plugin["version"], "0.1.0")
        self.assertEqual(plugin["license"], "MIT")
        if IN_REPO:  # an installed copy lives in a versioned cache folder (e.g. .../iphone-use/0.1.0)
            self.assertEqual(plugin["name"], PLUGIN.name)

    @unittest.skipUnless(IN_REPO, "repository files are not part of an installed plugin")
    def test_versions_agree(self):
        plugin = self.load(PLUGIN / ".claude-plugin" / "plugin.json")
        marketplace = self.load(REPO / ".claude-plugin" / "marketplace.json")
        self.assertEqual(marketplace["plugins"][0]["version"], plugin["version"])
        self.assertIn("## " + plugin["version"], read(PLUGIN / "CHANGELOG.md"))

    def test_server_version_matches_manifest(self):
        if not (PLUGIN / "server" / "version.py").is_file():
            self.skipTest("server/version.py not written yet")
        import version
        self.assertEqual(version.VERSION, EXPECTED_PLUGIN["version"])

    def test_mcp_config_is_exact(self):
        config = self.load(PLUGIN / ".mcp.json")
        self.assertEqual(config, EXPECTED_MCP)
        server = config["mcpServers"]["iphone"]
        self.assertNotIn("cwd", server)
        self.assertEqual(server["command"], "python3")
        self.assertTrue(server["args"][0].startswith("${CLAUDE_PLUGIN_ROOT}/"))
        plugin = self.load(PLUGIN / ".claude-plugin" / "plugin.json")
        server_name = list(config["mcpServers"])[0]
        self.assertEqual("mcp__plugin_%s_%s__" % (plugin["name"], server_name), FULL_NAME_PREFIX)

    def test_mcp_entry_point_exists(self):
        entry = PLUGIN / EXPECTED_MCP["mcpServers"]["iphone"]["args"][0].replace("${CLAUDE_PLUGIN_ROOT}/", "")
        self.assertTrue(entry.parent.is_dir(), str(entry.parent))
        if not entry.exists():
            self.skipTest("the MCP entry point is written by a later build unit")
        self.assertTrue(entry.is_file())

    def test_manifests_are_pretty_json_files(self):
        paths = [PLUGIN / ".claude-plugin" / "plugin.json", PLUGIN / ".mcp.json"]
        if IN_REPO:
            paths.append(REPO / ".claude-plugin" / "marketplace.json")
        for path in paths:
            text = read(path)
            self.assertTrue(text.endswith("\n"), rel(path))
            self.assertNotIn("\t", text, rel(path))
            json.loads(text)

    def test_gitignore(self):
        lines = read(PLUGIN / ".gitignore").splitlines()
        self.assertEqual(lines, ["__pycache__/", "*.pyc", ".DS_Store"])


class SkillTests(unittest.TestCase):
    def test_skill_directories_and_reference_files(self):
        found = sorted(p.name for p in (PLUGIN / "skills").iterdir() if p.is_dir())
        self.assertEqual(found, sorted(SKILL_REFERENCES))
        for skill, expected in SKILL_REFERENCES.items():
            directory = PLUGIN / "skills" / skill
            self.assertTrue((directory / "SKILL.md").is_file(), skill)
            references = {p.name for p in (directory / "references").iterdir() if p.is_file()}
            self.assertEqual(references, expected, skill)

    def test_frontmatter(self):
        for skill, expected in SKILL_FRONTMATTER.items():
            fields, _body = frontmatter(PLUGIN / "skills" / skill / "SKILL.md")
            self.assertEqual(fields, expected, skill)
            self.assertEqual(fields["name"], skill)
            self.assertRegex(fields["name"], r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
            self.assertLessEqual(len(fields["name"]), 64)
            self.assertLessEqual(len(fields["description"]), 1024)
            self.assertLessEqual(len(fields["description"]) + len(fields.get("when_to_use", "")), 1536)

    def test_frontmatter_values_are_plain_yaml_scalars(self):
        # Keep the values safe for any YAML parser: no quoting, flow, block or comment syntax.
        for skill in SKILL_FRONTMATTER:
            fields, _body = frontmatter(PLUGIN / "skills" / skill / "SKILL.md")
            for key, value in fields.items():
                self.assertRegex(key, r"^[a-z_]+$")
                self.assertTrue(value and value == value.strip(), (skill, key))
                self.assertNotIn(value[0], "\"'[]{}>|*&!%@`#,?:-", (skill, key))
                self.assertNotIn(": ", value, (skill, key))
                self.assertNotIn(" #", value, (skill, key))

    def test_skill_length(self):
        for skill, limit in SKILL_LINE_LIMITS.items():
            lines = read(PLUGIN / "skills" / skill / "SKILL.md").splitlines()
            self.assertLessEqual(len(lines), 500, skill)
            self.assertLessEqual(len(lines), limit, skill)

    def test_every_reference_is_linked_from_its_skill(self):
        for skill, expected in SKILL_REFERENCES.items():
            text = read(PLUGIN / "skills" / skill / "SKILL.md")
            linked = {target.split("#")[0] for target in LINK_RE.findall(text)}
            for name in expected:
                self.assertIn("references/" + name, linked, (skill, name))

    def test_tools_reference_lists_all_full_names(self):
        text = read(PLUGIN / "skills" / "iphone-use" / "references" / "tools.md")
        table = markdown_tables(text)[0]
        self.assertEqual(table[1][0], "Tool")
        self.assertEqual([row[0] for row in table[2]], ["`%s`" % name for name in TOOL_NAMES])
        self.assertEqual([row[1] for row in table[2]], ["`%s%s`" % (FULL_NAME_PREFIX, name) for name in TOOL_NAMES])
        self.assertIn(FULL_NAME_PREFIX + "iphone_<name>", text)

    def test_failures_table_matches_error_catalog(self):
        text = read(PLUGIN / "skills" / "iphone-use" / "references" / "failures.md")
        code_tables = [table for table in markdown_tables(text) if table[1][0] == "Code"]
        self.assertEqual(len(code_tables), 1)
        header_line, header, rows = code_tables[0]
        self.assertEqual(re.sub(r"\s+", " ", header_line), "| Code | Meaning | What to do |")
        self.assertEqual(header, ["Code", "Meaning", "What to do"])
        codes = []
        for row in rows:
            self.assertEqual(len(row), 3, row)
            self.assertTrue(row[1] and row[2], row)
            if row[0] == "Raw WebDriverAgent errors":
                continue
            match = re.fullmatch(r"`([a-z_]+)`", row[0])
            self.assertIsNotNone(match, row[0])
            codes.append(match.group(1))
        self.assertEqual(len(codes), 41)
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(set(codes), set(ERROR_CODES))
        self.assertEqual(rows[-1][0], "Raw WebDriverAgent errors")
        for raw in RAW_WDA_ERRORS:
            self.assertIn("`%s`" % raw, rows[-1][1])

    def test_failures_table_matches_server_catalog_when_available(self):
        try:
            import mcp_schemas
        except ImportError:
            self.skipTest("server/mcp_schemas.py is written by a later build unit")
        self.assertEqual(set(mcp_schemas.MODEL_ERROR_CODES), set(ERROR_CODES))
        names = getattr(mcp_schemas, "TOOL_NAMES", None)
        if names is not None:
            self.assertEqual(tuple(names), TOOL_NAMES)

    def test_ask_user_question_examples(self):
        auth = read(PLUGIN / "skills" / "iphone-use" / "references" / "authentication.md")
        self.assertIn(EXPECTED_AUTH_QUESTION, [json.loads(block) for block in code_blocks(auth, "json")])
        examples = 0
        for path in skill_docs():
            for block in code_blocks(read(path), "json"):
                document = json.loads(block)
                if not isinstance(document, dict) or "questions" not in document:
                    continue
                examples += 1
                for question in document["questions"]:
                    self.assertEqual(set(question), {"question", "header", "multiSelect", "options"}, rel(path))
                    self.assertLessEqual(len(question["header"]), 12, rel(path))
                    self.assertIs(question["multiSelect"], False)
                    labels = [option["label"] for option in question["options"]]
                    self.assertTrue(2 <= len(labels) <= 4, rel(path))
                    self.assertEqual(len(labels), len(set(labels)))
                    for option in question["options"]:
                        self.assertEqual(set(option), {"label", "description"})
        self.assertGreaterEqual(examples, 2)

    def test_hand_over_options_are_consistent(self):
        for path in (PLUGIN / "skills" / "iphone-use" / "SKILL.md",
                     PLUGIN / "skills" / "iphone-use" / "references" / "authentication.md",
                     PLUGIN / "skills" / "iphone-use-setup" / "SKILL.md"):
            text = read(path)
            self.assertIn("AskUserQuestion", text, rel(path))
            self.assertIn('"Done, continue"', text, rel(path))
            self.assertIn("I can't do this now", text, rel(path))
        for path in skill_docs():
            self.assertNotIn("Can't do it now", read(path), rel(path))

    def test_operating_skill_covers_claude_code_specifics(self):
        text = flat(read(PLUGIN / "skills" / "iphone-use" / "SKILL.md"))
        for phrase in ("ToolSearch", "Read tool", "iphone_ready(recover=true)", "iphone_screen(action=open)",
                       "Money and irreversible actions", "AskUserQuestion", "python3 --version",
                       "not flagged as a tool error", "image.pixel_to_point", "continue_token",
                       "iphone_screen(action=pause)", "iphone_screen(action=resume)"):
            self.assertIn(phrase, text, phrase)
        tools = read(PLUGIN / "skills" / "iphone-use" / "references" / "tools.md")
        self.assertIn("isError", tools)
        self.assertIn("Read tool", tools)
        fallback = flat(read(PLUGIN / "skills" / "iphone-use" / "references" / "cli-fallback.md"))
        example = """python3 "<plugin root>/scripts/phone.py" iphone_observe '{"mode":"screenshot"}'"""
        for phrase in ("ToolSearch", "python3 --version", example, "two levels above this skill's base directory",
                       "Read tool", "--state-dir", "device_busy"):
            self.assertIn(phrase, fallback, phrase)


class AmendmentContentTests(unittest.TestCase):
    """Facts the design amendments require the documentation to state."""

    def test_usb_only_default_is_documented(self):
        readme = read(PLUGIN / "README.md")
        safety = flat(section(readme, "Safety and privacy"))
        self.assertIn("by default the helper accepts connections only over the USB cable while it runs", safety)
        self.assertIn("stop it when you are done", safety)
        # Apps and pages on the iPhone itself can reach its loopback address; the README must not hide that.
        self.assertIn("Apps and web pages open on the iPhone itself can still reach it", safety)
        # Screen contents go to Claude: the README must not promise that everything stays on the Mac.
        self.assertNotIn("Everything stays on your Mac", readme)
        self.assertIn("sent to Claude as part of your conversation", safety)
        self.assertIn("App Store", safety)
        permissions = flat(section(readme, "Fewer permission prompts"))
        self.assertNotIn("still asks before money-moving or irreversible steps", permissions)
        self.assertIn("only when you asked for that exact action", permissions)
        preview = flat(read(PLUGIN / "skills" / "iphone-use" / "references" / "preview.md"))
        self.assertIn("By default the iPhone helper accepts connections only over the USB cable", preview)
        self.assertIn("allow_network", preview)

    def test_wifi_mentions_are_qualified(self):
        # No document may claim the helper is simply reachable from the Wi-Fi (the default is USB only).
        qualifiers = ("allow_network", "USB", "usb_only", "network access", "`network`")
        for path in unit_docs():
            for item in doc_items(read(path)):
                if "Wi-Fi" in item and not item.startswith("#"):
                    self.assertTrue(any(word in item for word in qualifiers), "%s: %s" % (rel(path), item))

    def test_allow_network_needs_the_user_and_a_rebuild(self):
        order = ("iphone_setup(action=stop)", 'iphone_setup(action=configure, network_mode="allow_network")',
                 "iphone_setup(action=build)", "iphone_setup(action=start)")
        setup = read(PLUGIN / "skills" / "iphone-use-setup" / "SKILL.md")
        usb_section = flat(section(setup, "7. USB-only"))
        trouble = read(PLUGIN / "skills" / "iphone-use-setup" / "references" / "troubleshooting.md")
        rows = [item for item in doc_items(trouble) if "allow_network" in item]
        self.assertEqual(len(rows), 1)
        for text in (usb_section, rows[0]):
            self.assertIn("AskUserQuestion", text)
            positions = [text.find(step) for step in order]
            self.assertNotIn(-1, positions, text)
            self.assertEqual(positions, sorted(positions), text)
        for path in skill_docs() + readmes():
            for item in doc_items(read(path)):
                if "allow_network" in item and "network_mode" in item and "configure" in item:
                    self.assertTrue("ask" in item.lower() or "agree" in item.lower(), "%s: %s" % (rel(path), item))

    def test_plugin_start_failure_row(self):
        expected = ("| Claude says the iPhone tools are missing, or /mcp shows the iphone server as failed | Ask "
                    "Claude to run `python3 --version` in the terminal | If it mentions the Xcode license: open "
                    "Xcode once and click Agree (or run `sudo xcodebuild -license accept` in Terminal), then "
                    "restart Claude Code. If a window offers to install 'command line developer tools', install "
                    "Xcode from the App Store and open it once instead. This can happen again after Xcode updates "
                    "itself. |")

        def normalize(text):
            return re.sub(r"\s+", " ", text.replace('"', "'")).strip()

        troubleshooting = PLUGIN / "skills" / "iphone-use-setup" / "references" / "troubleshooting.md"
        lines = [normalize(line) for line in read(troubleshooting).splitlines()]
        self.assertIn(normalize(expected), lines)
        readme_tables = [table for table in markdown_tables(read(PLUGIN / "README.md")) if table[1][0] == "Problem"]
        self.assertEqual(len(readme_tables), 1)
        readme_rows = readme_tables[0][2]
        self.assertEqual(normalize(readme_rows[0][0]), normalize(expected.split(" | ")[0].lstrip("| ")))
        self.assertIn("python3 --version", readme_rows[0][1])
        self.assertIn("sudo xcodebuild -license accept", readme_rows[0][1])
        self.assertLessEqual(10, len(readme_rows))

    def test_first_time_blockers_are_documented(self):
        first = flat(read(PLUGIN / "skills" / "iphone-use-setup" / "references" / "first-time-setup.md"))
        trouble = flat(read(PLUGIN / "skills" / "iphone-use-setup" / "references" / "troubleshooting.md"))
        for text in (first, trouble):
            self.assertIn("Settings > Components", text)
            self.assertIn("Get next to iOS", text)
            self.assertIn("Preparing iPhone", text)
            self.assertIn("Developer Mode is not listed", text)
        self.assertIn("update macOS first", trouble)
        readme = flat(read(PLUGIN / "README.md"))
        self.assertIn("for an iPhone on iOS 26 that is Xcode 26, which needs macOS 15.6 or newer", readme)
        self.assertNotIn("macOS 14 or newer", readme)

    def test_usbmux_rows(self):
        trouble = read(PLUGIN / "skills" / "iphone-use-setup" / "references" / "troubleshooting.md")
        for needle in ("usbmuxd_unavailable", "device_not_found", "connection_refused",
                       "failed to start web server on port"):
            self.assertIn(needle, trouble)
        for banned in ("Node", "npm", "18100", "local_port", "TIME_WAIT"):
            self.assertNotIn(banned, trouble)

    def test_secrets_written_in_chat_are_never_repeated(self):
        skill = flat(section(read(PLUGIN / "skills" / "iphone-use" / "SKILL.md"),
                             "8. Passwords, codes, Face ID and unlocking"))
        auth = flat(read(PLUGIN / "skills" / "iphone-use" / "references" / "authentication.md"))
        self.assertIn("writes a password, passcode, PIN or verification code in the chat", skill)
        self.assertIn("writes one in the chat anyway", auth)
        for text in (skill, auth):
            self.assertIn("never repeat it", text)
            self.assertIn("any tool call", text)
            self.assertIn("type it on the iPhone themselves", text)

    def test_tool_search_loads_every_tool(self):
        # ToolSearch returns 5 results by default; 16 iphone tools are deferred, so every instruction to search
        # for them must ask for more.
        import mcp_schemas
        self.assertIn("ToolSearch and max_results 20", mcp_schemas.INSTRUCTIONS)
        mentions = 0
        for path in skill_docs() + readmes():
            for item in doc_items(read(path)):
                if "ToolSearch" in item and ("query" in item or "search" in item.lower().replace("toolsearch", "")):
                    mentions += 1
                    self.assertIn("max_results 20", item, "%s: %s" % (rel(path), item))
        self.assertGreaterEqual(mentions, 6)

    def test_default_state_dir_is_never_described_as_refused(self):
        for path in skill_docs() + readmes():
            text = read(path)
            self.assertNotIn("must be outside any Git project", text, rel(path))
        failures = read(PLUGIN / "skills" / "iphone-use" / "references" / "failures.md")
        self.assertIn("The default folder is always accepted", failures)


class DocumentHygieneTests(unittest.TestCase):
    def test_relative_links_resolve(self):
        for path in skill_docs() + readmes() + [PLUGIN / "THIRD_PARTY_NOTICES.md", PLUGIN / "CHANGELOG.md"]:
            boundary = REPO if path == REPO / "README.md" else PLUGIN
            for target in LINK_RE.findall(strip_code_blocks(read(path))):
                if "://" in target or target.startswith(("#", "mailto:")):
                    continue
                linked = (path.parent / target.split("#")[0]).resolve()
                self.assertTrue(linked.is_relative_to(boundary), "%s -> %s" % (rel(path), target))
                self.assertTrue(linked.exists(), "%s -> %s" % (rel(path), target))

    @unittest.skipUnless(IN_REPO, "repository files are not part of an installed plugin")
    def test_root_readme(self):
        text = read(REPO / "README.md")
        self.assertTrue(text.startswith("# da-one\n"))
        plugins = section(text, "Plugins")
        self.assertIn("iphone-use", plugins)
        self.assertIn("/plugin marketplace add subcinctus/da-one#claude/iphone-use-plugin", plugins)
        self.assertIn("--marketplace subcinctus/da-one#claude/iphone-use-plugin", plugins)
        self.assertIn("private", plugins)
        self.assertIn("/plugin install iphone-use@da-one", plugins)
        self.assertIn("(plugins/iphone-use/README.md)", plugins)

    def test_plugin_readme_sections(self):
        text = read(PLUGIN / "README.md")
        headings = [line[3:] for line in text.splitlines() if line.startswith("## ")]
        self.assertEqual(headings, [
            "What it is", "What you need", "Install in 5 steps", "First-run prompt", "Everyday use",
            "Fewer permission prompts", "Safety and privacy", "Updating", "Troubleshooting", "Uninstall",
            "Credits and license",
        ])
        prompt = code_blocks(section(text, "First-run prompt"), "text")
        self.assertEqual(prompt, [(
            "Set up iPhone Use for me. Use the iphone-use-setup skill: check my Mac and iPhone with iphone_doctor, "
            "guide me through anything I must do myself (Xcode sign-in, trusting this Mac, Developer Mode, trusting "
            "the developer app), use my own Apple team and an automatically chosen bundle ID, then fetch, build and "
            "start the iPhone helper and keep going until iphone_ready says ready. Then open the live iPhone screen "
            "for me. Explain each step in plain English and wait for me when I need to do something on the phone."
        )])
        install = section(text, "Install in 5 steps")
        # The repository is private and the plugin is on a branch until it is merged.
        self.assertIn("/plugin marketplace add subcinctus/da-one#claude/iphone-use-plugin", install)
        self.assertIn('claude plugin marketplace add "subcinctus/da-one#claude/iphone-use-plugin"', install)
        self.assertIn("--marketplace subcinctus/da-one#claude/iphone-use-plugin", install)
        self.assertIn("gh auth login", install)
        self.assertIn("private", install)
        self.assertIn("/plugin install iphone-use@da-one", install)
        updating = section(text, "Updating")
        # /plugin has no "update" subcommand (it only opens the menu): the CLI command updates the plugin.
        self.assertIn("claude plugin marketplace update da-one", updating)
        self.assertIn("claude plugin update iphone-use@da-one", updating)
        self.assertNotIn("/plugin update", updating)
        self.assertIn("/plugin uninstall iphone-use@da-one", section(text, "Uninstall"))
        self.assertIn("WebDriverAgentRunner", section(text, "Uninstall"))
        credits = section(text, "Credits and license")
        for phrase in ("MIT", "ZHONG XIN", "BSD-3-Clause", "THIRD_PARTY_NOTICES.md"):
            self.assertIn(phrase, credits)

    def test_permission_snippet_and_wildcard(self):
        text = read(PLUGIN / "README.md")
        permissions = section(text, "Fewer permission prompts")
        snippets = [json.loads(block) for block in code_blocks(permissions, "json")]
        self.assertEqual(snippets, [{"permissions": {"allow": [FULL_NAME_PREFIX + name
                                                               for name in READ_ONLY_ALLOWLIST]}}])
        self.assertIn('"%s*"' % FULL_NAME_PREFIX, permissions)
        # The wildcard appears only in the plugin README's permissions section.
        self.assertEqual(text.count(FULL_NAME_PREFIX + "*"), permissions.count(FULL_NAME_PREFIX + "*"))
        for path in unit_docs():
            if path != PLUGIN / "README.md":
                self.assertNotIn(FULL_NAME_PREFIX + "*", read(path), rel(path))

    def test_full_tool_names_are_real(self):
        for path in unit_docs():
            for match in FULL_NAME_RE.finditer(read(path)):
                name = match.group(1)
                self.assertTrue(name in TOOL_NAMES or name in ("*", "iphone_<name>"),
                                "%s: %r" % (rel(path), match.group(0)))

    def test_iphone_tokens_are_tool_names(self):
        for path in unit_docs():
            text = read(path)
            for match in TOOL_TOKEN_RE.finditer(text):
                token = match.group(0)
                if text.startswith(".py", match.end()) or token == "iphone_use":
                    continue
                self.assertIn(token, TOOL_NAMES, "%s: %s" % (rel(path), token))

    def test_retired_names_are_gone(self):
        # Reference-era codes and the pre-review "iphone_only" value must not survive anywhere in the docs.
        for retired in ("pua_unreachable", "pua_foreground_unavailable", "pua_recovery_required", "iphone_only",
                        "max_attempts", "local_port", "WDA_STATE_DIR"):
            for path in unit_docs():
                self.assertNotIn(retired, read(path), "%s: %s" % (rel(path), retired))

    def test_no_codex_constructs(self):
        for path in skill_docs() + readmes():
            text = read(path)
            for token in CODEX_TOKENS:
                self.assertNotIn(token, text, "%s: %s" % (rel(path), token))
            for token in CODEX_TOKENS_ANY_CASE:
                self.assertNotIn(token, text.lower(), "%s: %s" % (rel(path), token))
            self.assertIsNone(re.search(r"\bPUA\b", text), rel(path))
        for path in skill_docs():
            self.assertNotIn("CLAUDE_PLUGIN_ROOT", read(path), rel(path))
        # "Codex" itself may appear only in credit lines that name the original project.
        for path in unit_docs():
            for line in read(path).splitlines():
                if "codex" in line.lower():
                    self.assertTrue("ZHONG XIN" in line or "iPhone-use" in line, "%s: %s" % (rel(path), line))
        for path in skill_docs():
            self.assertNotIn("codex", read(path).lower(), rel(path))

    def test_no_cjk_characters(self):
        for path in unit_docs():
            match = CJK_RE.search(read(path))
            self.assertIsNone(match, "%s: %r" % (rel(path), match and match.group(0)))

    def test_markdown_is_well_formed(self):
        for path in unit_docs():
            text = read(path)
            self.assertTrue(text.endswith("\n") and not text.endswith("\n\n"), rel(path))
            self.assertNotIn("\t", text, rel(path))
            self.assertNotIn("\r", text, rel(path))
            fences = [line for line in text.splitlines() if FENCE_RE.match(line)]
            self.assertEqual(len(fences) % 2, 0, rel(path))
            for number, line in enumerate(text.splitlines(), 1):
                self.assertEqual(line, line.rstrip(), "%s:%d trailing whitespace" % (rel(path), number))
            for block in code_blocks(text, "json"):
                json.loads(block)
            for header_line, header, rows in markdown_tables(text):
                for row in rows:
                    self.assertEqual(len(row), len(header), "%s: %s" % (rel(path), row))

    def test_plain_language_for_the_user(self):
        # The model is told not to surface internals to the user, and to report coverage and limits.
        text = read(PLUGIN / "skills" / "iphone-use" / "SKILL.md")
        finishing = section(text, "9. Finishing")
        for word in ("WDA", "XCTest", "UDID", "error codes", "coverage"):
            self.assertIn(word, finishing)


class LegalAndRepositoryTests(unittest.TestCase):
    def test_license_is_mit_with_both_copyright_lines(self):
        text = read(PLUGIN / "LICENSE")
        lines = text.splitlines()
        self.assertEqual(lines[0], "MIT License")
        self.assertIn("Copyright (c) 2026 subcinctus", lines)
        self.assertIn("Copyright (c) 2026 ZHONG XIN (iPhone-use, from which this plugin's design is derived)", lines)
        flat = " ".join(text.split())
        for phrase in ("Permission is hereby granted, free of charge, to any person obtaining a copy",
                       "The above copyright notice and this permission notice shall be included in all copies or "
                       "substantial portions of the Software.",
                       'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND'):
            self.assertIn(phrase, flat)

    def test_third_party_notices(self):
        text = read(PLUGIN / "THIRD_PARTY_NOTICES.md")
        flat = " ".join(text.split())
        for phrase in ("ZHONG XIN", "https://github.com/zhongerxin/iPhone-use", "0.3.6", "License: MIT",
                       "Permission is hereby granted, free of charge",
                       "Appium WebDriverAgent", "16.14.0", "d17782422d55ff1e5e0ceb74eb1fd509cc0c35b6",
                       "License: BSD-3-Clause", "not bundled", "Redistributions of source code must retain",
                       "appium-ios-device", "3.1.24", "License: Apache-2.0", "protocol reference",
                       "No code from it is included"):
            self.assertIn(phrase, flat, phrase)
        if (PLUGIN / "server" / "wda_setup.py").is_file():
            self.assertIn('"d17782422d55ff1e5e0ceb74eb1fd509cc0c35b6"', read(PLUGIN / "server" / "wda_setup.py"))

    def test_changelog(self):
        text = read(PLUGIN / "CHANGELOG.md")
        self.assertIn("## 0.1.0 — first release for Claude Code", text.splitlines())
        bullets = [line for line in section(text, "0.1.0").splitlines() if line.startswith("- ")]
        self.assertGreaterEqual(len(bullets), 3)

    def test_check_script(self):
        path = PLUGIN / "scripts" / "check.sh"
        mode = path.stat().st_mode
        self.assertTrue(mode & stat.S_IXUSR and mode & stat.S_IXGRP and mode & stat.S_IXOTH, oct(mode))
        text = read(path)
        self.assertTrue(text.startswith("#!/bin/sh\n"))
        self.assertIn("set -eu", text)
        self.assertIn('cd "$(dirname "$0")/.."', text)
        self.assertIn('"$PYTHON" -m unittest discover -s tests', text)
        self.assertIn('"$PYTHON39" -m unittest discover -s tests', text)
        self.assertIn("node --check viewer/app.js", text)
        result = subprocess.run(["/bin/sh", "-n", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=10, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(IN_REPO, "repository files are not part of an installed plugin")
    def test_ci_workflow(self):
        path = REPO / ".github" / "workflows" / "iphone-use-check.yml"
        text = read(path)
        self.assertNotIn("\t", text)
        for phrase in ('"3.9"', '"3.12"', "runs-on: ubuntu-latest", "runs-on: macos-latest",
                       "actions/checkout@v4", "actions/setup-python@v5", '"plugins/iphone-use/**"',
                       '".claude-plugin/**"', '".github/workflows/iphone-use-check.yml"', "pull_request:", "push:"):
            self.assertIn(phrase, text, phrase)
        self.assertEqual(text.count("run: bash plugins/iphone-use/scripts/check.sh"), 2)
        top_level = [line.split(":")[0] for line in text.splitlines() if line and not line[0].isspace()]
        self.assertEqual(top_level, ["name", "on", "permissions", "jobs"])
        jobs = [line.strip().rstrip(":") for line in section_lines(text, "jobs") if re.match(r"^  \S", line)]
        self.assertEqual(jobs, ["linux", "macos"])


def section_lines(yaml_text, key):
    """Lines nested under a top-level YAML key."""
    lines, inside = [], False
    for line in yaml_text.splitlines():
        if line and not line[0].isspace():
            inside = line.startswith(key + ":")
            continue
        if inside:
            lines.append(line)
    return lines


class PythonGrammarTests(unittest.TestCase):
    def test_every_python_file_parses_as_python_3_9(self):
        files = [path for path in PLUGIN.rglob("*.py") if "__pycache__" not in path.parts]
        self.assertIn(Path(__file__).resolve(), [path.resolve() for path in files])
        for path in files:
            source = path.read_text(encoding="utf-8")
            try:
                ast.parse(source, filename=str(path), feature_version=(3, 9))
            except SyntaxError as exc:
                self.fail("%s is not Python 3.9 syntax: %s" % (rel(path), exc))


if __name__ == "__main__":
    unittest.main()
