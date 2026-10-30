"""Summarize the latest download status for items in a manifest."""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def doi_of(item: dict) -> str:
    match = re.search(r"10\.\d{4,9}/\S+", item.get("url") or "")
    return match.group(0) if match else ""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list", required=True, type=Path)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--json-out", required=True, type=Path)
    args = parser.parse_args()

    items = json.loads(args.list.read_text(encoding="utf-8"))
    by_id = {str(item["id"]): item for item in items}
    latest: dict[str, dict] = {}

    with args.log.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            item_id = str(row.get("id", ""))
            if item_id not in by_id:
                continue
            previous = latest.get(item_id)
            if previous is None or timestamp(row["ts"]) >= timestamp(previous["ts"]):
                latest[item_id] = row

    rows = []
    for item_id, item in by_id.items():
        result = latest.get(item_id, {})
        rows.append(
            {
                "id": item_id,
                "status": result.get("status", "unseen"),
                "note": result.get("note", ""),
                "last_ts": result.get("ts", ""),
                "doi": doi_of(item),
                "domain": item.get("domain", ""),
                "title": item.get("title", ""),
            }
        )

    statuses = Counter(row["status"] for row in rows)
    failures = [row for row in rows if row["status"] != "ok"]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.parent.mkdir(parents=True, exist_ok=True)

    with args.out.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(failures)

    summary = {
        "total": len(rows),
        "statuses": dict(statuses),
        "failures": len(failures),
        "failure_csv": str(args.out),
    }
    args.json_out.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print("failure_ids:", ",".join(row["id"] for row in failures))


if __name__ == "__main__":
    main()
