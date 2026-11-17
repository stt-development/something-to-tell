"""Inspect functional JUnit results without printing captured logs or properties."""
import argparse
import json
from pathlib import Path
from xml.etree import ElementTree


def inspect_report(path: Path, *, no_skips=False):
    root = ElementTree.parse(path).getroot()
    if root.tag not in {"testsuite", "testsuites"}:
        raise ValueError("unsupported test report")
    cases = root.findall(".//testcase")
    if not cases:
        raise ValueError("empty test report")
    skipped = [{"test": f"{case.get('classname', '')}.{case.get('name', '')}",
                "reason": case.find("skipped").get("message", "")}
               for case in cases if case.find("skipped") is not None]
    failures = sum(case.find("failure") is not None or case.find("error") is not None for case in cases)
    summary = {"tests": len(cases), "failures": failures, "skipped": skipped}
    return summary, not failures and not (no_skips and skipped)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--no-skips", action="store_true")
    args = parser.parse_args(argv)
    try:
        summary, accepted = inspect_report(args.report, no_skips=args.no_skips)
    except (OSError, ValueError, ElementTree.ParseError):
        print("CI test report is missing, invalid or empty.")
        return 1
    print(json.dumps(summary, ensure_ascii=True))
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
