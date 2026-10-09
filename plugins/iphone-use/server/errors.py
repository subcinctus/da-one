"""The one error type every tool-facing failure uses."""


class ToolError(Exception):
    """A failure the model sees as {"code", "message", "uncertain", **details}."""

    def __init__(self, code, message, uncertain=False, details=None):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)
        self.uncertain = bool(uncertain)
        self.details = dict(details or {})

    def as_dict(self):
        result = {"code": self.code, "message": self.message, "uncertain": self.uncertain}
        for key, value in self.details.items():
            if key not in result:
                result[key] = value
        return result

    def __str__(self):
        return self.message


def fail(code, message, uncertain=False, **details):
    """Raise ToolError(code, message, uncertain, details)."""
    raise ToolError(code, message, uncertain=uncertain, details=details)
