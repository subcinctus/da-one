#!/usr/bin/env python3
"""Prepare the patched WebDriverAgent checkout that CI builds (macOS runner; stdlib only).

    python3 scripts/ci_prepare_wda.py <new folder>

Downloads WebDriverAgent at the commit the plugin pins (wda_setup.WDA_REPOSITORY and WDA_COMMIT) the same way
iphone_setup(action="fetch") does, applies the plugin's own source patches (wda_setup.apply_patches) and checks
the result with the plugin's own verification (SetupManager._verify_source): the folder must hold the pinned
commit with exactly the plugin's patches, byte for byte. CI therefore compiles what users build.

Prints every step; exits 1 when anything differs.
"""

import argparse
import os
import pathlib
import subprocess
import sys
import tempfile

PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_DIR = os.path.join(PLUGIN_ROOT, "server")
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import wda_setup  # noqa: E402
from errors import ToolError  # noqa: E402


class PrepareError(Exception):
    """The checkout could not be prepared; the message says why."""


def git(*args) -> None:
    """Run one git command and print its output; PrepareError when it fails."""
    argv = ["git"] + [str(arg) for arg in args]
    print("+ " + " ".join(argv), flush=True)
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors="replace", check=False)
    except OSError as exc:
        raise PrepareError("git could not be run: %s" % exc) from None
    print(result.stdout, end="", flush=True)
    if result.returncode != 0:
        raise PrepareError("%s exited with code %d." % (" ".join(argv), result.returncode))


def download(target, repository, commit) -> None:
    """git init, then a depth-1 fetch of exactly one commit and a detached checkout (as the fetch job does)."""
    target.mkdir(parents=True, exist_ok=True)
    if any(target.iterdir()):
        raise PrepareError("%s is not empty; pass a new folder." % target)
    git("init", "-q", target)
    git("-C", target, "remote", "add", "origin", repository)
    git("-C", target, "fetch", "--depth", "1", "origin", commit)
    git("-C", target, "checkout", "-q", "--detach", "FETCH_HEAD")


def patch_and_verify(target) -> None:
    """Apply the plugin's patches to the fresh checkout and prove the result is exactly the patched state."""
    with tempfile.TemporaryDirectory(prefix="iphone-use-ci-") as state_dir:
        manager = wda_setup.SetupManager(state_dir)
        try:
            if manager._verify_source(target, owned=True)["patched"]:
                raise PrepareError("The fresh checkout is already patched; pass a new folder.")
            print("Pinned commit %s checked out, no local changes." % wda_setup.WDA_COMMIT, flush=True)
            wda_setup.apply_patches(target)
            state = manager._verify_source(target, owned=True)
        except ToolError as exc:
            raise PrepareError(exc.message) from None
        except RuntimeError as exc:
            raise PrepareError(str(exc)) from None
    if not state["patched"]:
        raise PrepareError("The plugin's patches left no change in the checkout.")
    for patch in wda_setup.PATCHES:
        print("Patched %s (%s)." % (patch.path, patch.marker), flush=True)
    print("Verified: the pinned commit plus exactly the plugin's patches (SetupManager._verify_source).",
          flush=True)


def prepare(target, repository=None, commit=None) -> None:
    """Download, patch and verify into target (a new folder); PrepareError on any problem."""
    target = pathlib.Path(target).expanduser().resolve()
    repository = repository or wda_setup.WDA_REPOSITORY
    commit = commit or wda_setup.WDA_COMMIT
    print("WebDriverAgent %s (%s) from %s into %s" % (wda_setup.WDA_VERSION, commit, repository, target),
          flush=True)
    download(target, repository, commit)
    patch_and_verify(target)
    git("-C", target, "diff", "--stat")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Download the pinned WebDriverAgent and apply iPhone Use's source patches (for CI builds).")
    parser.add_argument("target", help="a new folder for the checkout")
    parser.add_argument("--repository", help="where to fetch from (default: the plugin's pinned upstream)")
    args = parser.parse_args(argv)
    try:
        prepare(args.target, repository=args.repository)
    except PrepareError as exc:
        print("ci_prepare_wda: %s" % exc, file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
