import os
import sys
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(os.path.dirname(HERE), "server")
for _p in (SERVER, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import ast  # noqa: E402
import glob  # noqa: E402
import re  # noqa: E402
import unittest  # noqa: E402

import mcp_schemas  # noqa: E402
from mcp_schemas import MODEL_ERROR_CODES, TOOL_NAMES  # noqa: E402

PLUGIN = os.path.dirname(HERE)
REPO_README = os.path.join(os.path.dirname(os.path.dirname(PLUGIN)), "README.md")
SKILLS = os.path.join(PLUGIN, "skills")
TOKEN_RE = re.compile(r"\biphone_[a-z][a-z_]*")
FULL_NAME_RE = re.compile(r"mcp__plugin_iphone-use_iphone__(\*|iphone_<name>|[A-Za-z0-9_]*)")
CODE_CELL_RE = re.compile(r"`([a-z_]+)`")
# Callables whose first argument is an error code: ToolError(code, ...) anywhere, errors.fail(code, ...)
# and wda_setup._error(code, ...) when called by their bare names.
ERROR_FACTORIES = ("ToolError", "fail", "_error")


def tool_tokens(text):
    """Every iphone_* token in text, except module names (iphone_use, *.py)."""
    tokens = []
    for match in TOKEN_RE.finditer(text):
        token = match.group(0)
        if token == "iphone_use" or text.startswith(".py", match.end()):
            continue
        tokens.append(token)
    return tokens


def server_sources():
    return sorted(glob.glob(os.path.join(SERVER, "*.py")))


def string_literals(path):
    with open(path, encoding="utf-8") as handle:
        tree = ast.parse(handle.read(), filename=path)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            yield node.lineno, node.value


def documents():
    paths = sorted(glob.glob(os.path.join(SKILLS, "**", "*.md"), recursive=True))
    paths.append(os.path.join(PLUGIN, "README.md"))
    if os.path.isfile(REPO_README):
        paths.append(REPO_README)
    return paths


def read(path):
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def markdown_tables(text):
    """[(header cells, [body rows of cells])] for every pipe table in text."""
    tables = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        following = lines[index + 1].strip() if index + 1 < len(lines) else ""
        if line.startswith("|") and re.fullmatch(r"\|(\s*:?-+:?\s*\|)+", following):
            header = [cell.strip() for cell in line.strip("|").split("|")]
            rows = []
            index += 2
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append([cell.strip() for cell in lines[index].strip().strip("|").split("|")])
                index += 1
            tables.append((header, rows))
            continue
        index += 1
    return tables


class ToolNameConsistencyTests(unittest.TestCase):
    def test_server_string_literals_name_only_real_tools(self):
        problems = []
        for path in server_sources():
            for line, value in string_literals(path):
                for token in tool_tokens(value):
                    if token not in TOOL_NAMES:
                        problems.append("%s:%d %s" % (os.path.basename(path), line, token))
        self.assertEqual(problems, [])
        self.assertIn(os.path.join(SERVER, "runtime.py"), server_sources())

    def test_skills_and_readmes_name_only_real_tools(self):
        problems = []
        seen = set()
        for path in documents():
            for token in tool_tokens(read(path)):
                seen.add(token)
                if token not in TOOL_NAMES:
                    problems.append("%s: %s" % (os.path.relpath(path, PLUGIN), token))
        self.assertEqual(problems, [])
        self.assertGreater(len(seen), 10)

    def test_full_claude_code_names_are_real_tools(self):
        problems = []
        found = 0
        for path in documents():
            for match in FULL_NAME_RE.finditer(read(path)):
                found += 1
                name = match.group(1)
                if name not in TOOL_NAMES and name not in ("*", "iphone_<name>"):
                    problems.append("%s: %r" % (os.path.relpath(path, PLUGIN), match.group(0)))
        self.assertEqual(problems, [])
        self.assertGreater(found, 0)

    def test_tools_reference_lists_every_full_name(self):
        text = read(os.path.join(SKILLS, "iphone-use", "references", "tools.md"))
        for name in TOOL_NAMES:
            with self.subTest(tool=name):
                self.assertIn("mcp__plugin_iphone-use_iphone__" + name, text)

    def test_instructions_name_the_two_skills_which_exist(self):
        text = mcp_schemas.INSTRUCTIONS
        for skill in ("iphone-use", "iphone-use-setup"):
            with self.subTest(skill=skill):
                self.assertRegex(text, r"\b%s\b" % re.escape(skill))
                skill_file = os.path.join(SKILLS, skill, "SKILL.md")
                self.assertTrue(os.path.isfile(skill_file))
                self.assertRegex(read(skill_file), r"(?m)^name: %s$" % re.escape(skill))

    def test_descriptions_and_instructions_name_only_real_tools(self):
        texts = list(mcp_schemas.DESCRIPTIONS.values()) + [mcp_schemas.INSTRUCTIONS]
        for entry in mcp_schemas.TOOLS:
            texts.append(str(entry["inputSchema"]))
        for text in texts:
            self.assertLessEqual(set(tool_tokens(text)), set(TOOL_NAMES))


class ErrorCodeConsistencyTests(unittest.TestCase):
    def failures_table(self):
        text = read(os.path.join(SKILLS, "iphone-use", "references", "failures.md"))
        for header, rows in markdown_tables(text):
            if header and header[0] == "Code":
                return header, rows
        self.fail("failures.md has no table whose first header cell is Code")

    def test_failures_table_documents_exactly_the_model_error_codes(self):
        header, rows = self.failures_table()
        self.assertEqual(header, ["Code", "Meaning", "What to do"])
        codes = []
        for row in rows:
            cell = row[0]
            if cell == "Raw WebDriverAgent errors":
                continue
            match = CODE_CELL_RE.fullmatch(cell)
            if match:
                codes.append(match.group(1))
        self.assertEqual(len(codes), len(set(codes)), "duplicate rows")
        self.assertEqual(len(codes), 41)
        self.assertEqual(set(codes), set(MODEL_ERROR_CODES))
        self.assertIn("Raw WebDriverAgent errors", [row[0] for row in rows])

    def test_raw_errors_row_lists_the_passthrough_strings(self):
        _, rows = self.failures_table()
        raw = [row for row in rows if row[0] == "Raw WebDriverAgent errors"]
        self.assertEqual(len(raw), 1)
        for text in mcp_schemas.RAW_WDA_ERRORS:
            self.assertIn(text, raw[0][1])

    def test_server_raises_only_catalogued_codes(self):
        allowed = set(MODEL_ERROR_CODES) | set(mcp_schemas.TOOLBAR_ERROR_CODES) | set(mcp_schemas.RAW_WDA_ERRORS)
        problems = []
        checked = 0
        for path in server_sources():
            with open(path, encoding="utf-8") as handle:
                tree = ast.parse(handle.read(), filename=path)
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not node.args:
                    continue
                func = node.func
                if isinstance(func, ast.Name):
                    name = func.id
                elif isinstance(func, ast.Attribute) and func.attr == "ToolError":
                    name = "ToolError"
                else:
                    continue
                first = node.args[0]
                if name in ERROR_FACTORIES and isinstance(first, ast.Constant) and isinstance(first.value, str):
                    checked += 1
                    if first.value not in allowed:
                        problems.append("%s:%d %s" % (os.path.basename(path), node.lineno, first.value))
        self.assertEqual(problems, [])
        self.assertGreater(checked, 50)


if __name__ == "__main__":
    unittest.main()
