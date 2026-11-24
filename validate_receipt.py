"""Validate the receipt from the disposable native image transport pilot."""

import argparse
import json
from pathlib import Path


MODELS = {"codex": "gpt-6.2-sol", "claude": "claude-sonnet-5-5"}


def check_identity(records):
    if not isinstance(records, list) or len(records) != len(MODELS):
        raise ValueError("Expected exactly one receipt per pilot provider.")
    providers = set()
    for record in records:
        if not isinstance(record, dict):
            raise ValueError("Each provider receipt must be an object.")
        provider = record.get("provider")
        if not isinstance(provider, str) or provider not in MODELS or provider in providers:
            raise ValueError("Expected one Codex receipt and one Claude receipt.")
        if record.get("model") != MODELS[provider] or record.get("effort") != "medium":
            raise ValueError(f"{provider} model or effort differs from the pilot setup.")
        providers.add(provider)


def check_observations(records):
    required = ("sameTurnCodeMatchedPrivateOracle", "codeAbsentFromPrompt", "idleAfter")
    for record in records:
        if any(record.get(key) is not True for key in required):
            raise ValueError(f"{record['provider']} image observation is incomplete or invalid.")
        message_count = record.get("matchingUserMessages")
        if type(message_count) is not int or message_count != 1:
            raise ValueError(f"{record['provider']} must have exactly one matching user message.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    args = parser.parse_args()
    try:
        records = json.loads(args.receipt.read_text())
        check_identity(records)
        check_observations(records)
    except (OSError, ValueError) as error:
        raise SystemExit(str(error)) from None
    print("Native pilot provider identities and image observations verified.")


if __name__ == "__main__":
    main()
