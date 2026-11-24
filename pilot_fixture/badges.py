"""Return the visible badge for a task state."""


BADGE_LABELS = {"active": "Active", "paused": "Active", "done": "Done"}


def badge_label(state: str) -> str:
    return BADGE_LABELS[state]
