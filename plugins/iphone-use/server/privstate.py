"""The private state directory and small file, lock and time helpers.

Everything iPhone Use keeps on disk lives in one private folder (directories 0700,
files 0600). Files are always written atomically (temp file in the same folder,
then os.replace) so readers never see a half-written file.
"""

import errno
import fcntl
import json
import os
import pathlib
import tempfile
from datetime import datetime, timezone
from typing import Optional

from errors import ToolError

STATE_ENV = "IPHONE_USE_STATE_DIR"
DEFAULT_STATE_DIR = "~/.local/share/iphone-use"
CONFIG_NAME = "config.json"
GITIGNORE_NAME = ".gitignore"
GITIGNORE_CONTENT = b"*\n"

UNSAFE_MESSAGE = (
    "The iPhone Use data folder must be outside any Git project so screenshots and settings never end up "
    "in a repository. Set IPHONE_USE_STATE_DIR to a private folder such as ~/.local/share/iphone-use."
)


# --- state directory -------------------------------------------------------------------------------


def state_directory(explicit=None, env=None) -> pathlib.Path:
    """Return the state directory: explicit > $IPHONE_USE_STATE_DIR > ~/.local/share/iphone-use.

    The result is expanded and resolved; nothing is created.
    """
    if explicit is not None and str(explicit) != "":
        raw = explicit
    else:
        environ = os.environ if env is None else env
        value = environ.get(STATE_ENV)
        raw = value if value else DEFAULT_STATE_DIR
    return pathlib.Path(raw).expanduser().resolve()


def default_state_dir() -> pathlib.Path:
    """The default state directory, evaluated now (HOME may change between calls)."""
    return pathlib.Path(DEFAULT_STATE_DIR).expanduser().resolve()


def _exists(path) -> bool:
    try:
        return os.path.lexists(str(path))
    except (OSError, ValueError):
        return False


def check_outside_git(path) -> None:
    """Raise state_dir_unsafe if path or any existing ancestor contains a .git entry."""
    resolved = pathlib.Path(path).expanduser().resolve()
    for candidate in (resolved,) + tuple(resolved.parents):
        if _exists(candidate / ".git"):
            raise ToolError("state_dir_unsafe", UNSAFE_MESSAGE, details={"state_dir": str(resolved)})


def prepare_state_dir(path) -> pathlib.Path:
    """Create (0700) and return the state directory, refusing a non-default one inside Git.

    The default folder is always accepted; every state folder gets a .gitignore
    containing "*" so Git ignores it wherever it lives.
    """
    resolved = pathlib.Path(path).expanduser().resolve()
    if resolved != default_state_dir():
        check_outside_git(resolved)
    resolved.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(str(resolved), 0o700)
    gitignore = resolved / GITIGNORE_NAME
    try:
        current = gitignore.read_bytes()
    except OSError:
        current = None
    if current != GITIGNORE_CONTENT:
        write_bytes_private(gitignore, GITIGNORE_CONTENT)
    else:
        try:
            if (os.stat(str(gitignore)).st_mode & 0o777) != 0o600:
                os.chmod(str(gitignore), 0o600)
        except OSError:
            pass
    return resolved


def private_subdir(state_dir, name) -> pathlib.Path:
    """Create state_dir/name (and parents) with mode 0700 and return it."""
    directory = pathlib.Path(state_dir) / name
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(str(directory), 0o700)
    return directory


# --- private files ---------------------------------------------------------------------------------


def write_bytes_private(path, data: bytes) -> None:
    """Atomically replace path with data, mode 0600. The temp file never outlives a failure."""
    target = pathlib.Path(path)
    payload = bytes(data) if isinstance(data, (bytearray, memoryview)) else data
    if not isinstance(payload, bytes):
        raise TypeError("write_bytes_private needs bytes")
    fd, temp_path = tempfile.mkstemp(dir=str(target.parent), prefix=".write-")
    try:
        try:
            os.fchmod(fd, 0o600)
            view = memoryview(payload)
            while view:
                written = os.write(fd, view)
                view = view[written:]
        finally:
            os.close(fd)
        os.replace(temp_path, str(target))
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def write_json_private(path, data, indent=None) -> None:
    """Write data as UTF-8 JSON (compact unless indent is given) plus a newline, mode 0600."""
    separators = (",", ":") if indent is None else None
    text = json.dumps(data, ensure_ascii=False, allow_nan=False, indent=indent, separators=separators)
    write_bytes_private(path, (text + "\n").encode("utf-8"))


def read_json(path, default=None):
    """Parsed JSON from path, or default when it is missing or unreadable."""
    try:
        with open(str(path), "rb") as handle:
            raw = handle.read()
        return json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return default


def read_config(state_dir) -> dict:
    """config.json as a dict ({} when missing, corrupt or not an object)."""
    data = read_json(pathlib.Path(state_dir) / CONFIG_NAME, {})
    return data if isinstance(data, dict) else {}


def config_int(config, key, default, low=1024, high=65535) -> int:
    """config[key] when it is an int (not bool) within [low, high], else default."""
    value = config.get(key) if isinstance(config, dict) else None
    if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high:
        return value
    return default


# --- locks -----------------------------------------------------------------------------------------


class FileLock:
    """flock-based lock on a private file. Usable as a context manager.

    flock locks belong to the open file description, so two FileLock objects on
    the same path conflict even inside one process. The descriptor is not
    inherited by child processes.
    """

    def __init__(self, path, blocking=True):
        self.path = pathlib.Path(path)
        self.blocking = bool(blocking)
        self._fd = None

    @property
    def held(self) -> bool:
        return self._fd is not None

    def acquire(self) -> "FileLock":
        if self._fd is not None:
            raise RuntimeError("This FileLock is already held.")
        fd = os.open(str(self.path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.fchmod(fd, 0o600)
            flags = fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB)
            try:
                fcntl.flock(fd, flags)
            except OSError as exc:
                if not self.blocking and exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                    raise BlockingIOError(exc.errno, "The lock is held by someone else.") from None
                raise
        except BaseException:
            os.close(fd)
            raise
        self._fd = fd
        return self

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            os.close(fd)

    def __enter__(self) -> "FileLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, traceback) -> bool:
        self.release()
        return False


# --- time and processes ----------------------------------------------------------------------------


def iso_now() -> str:
    """Current UTC time as ISO 8601 with an explicit +00:00 offset."""
    return datetime.now(timezone.utc).isoformat()


def parse_iso(text) -> Optional[datetime]:
    """Parse an aware ISO 8601 timestamp ("+00:00" or trailing "Z"); naive or invalid -> None."""
    if not isinstance(text, str):
        return None
    candidate = text.strip()
    if candidate.endswith(("Z", "z")):
        candidate = candidate[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed


def pid_alive(pid) -> bool:
    """True when a process with this PID exists (even if owned by another user)."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except (OSError, OverflowError):
        return False
    return True


def prune_files(directory, pattern, keep) -> int:
    """Delete all but the newest `keep` files matching pattern (newest = greatest name).

    Returns how many files were removed; filesystem errors are ignored.
    """
    try:
        keep = max(0, int(keep))
    except (TypeError, ValueError):
        return 0
    try:
        candidates = [p for p in pathlib.Path(directory).glob(pattern) if not p.is_dir()]
    except OSError:
        return 0
    candidates.sort(key=lambda p: (p.name, str(p)))
    victims = candidates[:len(candidates) - keep] if keep else candidates
    removed = 0
    for victim in victims:
        try:
            victim.unlink()
            removed += 1
        except OSError:
            pass
    return removed
