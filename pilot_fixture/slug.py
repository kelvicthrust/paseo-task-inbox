"""Create the path segment used for a saved view."""


def view_slug(label: str) -> str:
    return label.strip().lower().replace(" ", "-")
