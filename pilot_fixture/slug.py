"""Create the path segment used for a saved view."""

import re


def view_slug(label: str) -> str:
    return re.sub(r" +", "-", label.strip().lower())
