"""AH32 (阿蛤) runtime package (module name: ah32)."""

from importlib import metadata

from .config import Ah32Settings, settings

__all__ = ["Ah32Settings", "settings", "__version__"]


def _load_version() -> str:
    # Editable installs may use different distribution names. Keep minimal fallbacks.
    for dist in ("ah32",):
        try:
            version = metadata.version(dist)
            return str(version) if version is not None else "0.0.0"
        except metadata.PackageNotFoundError:
            continue
        except TypeError:
            continue
    return "0.0.0"


__version__ = _load_version()
