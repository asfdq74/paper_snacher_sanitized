"""Filter papers by owner from an export workbook.

The source workbook contains malformed empty <fill/> style nodes, so the
workbook is sanitized in memory before openpyxl reads it.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import zipfile
from collections import Counter
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".local_libs"))

from openpyxl import load_workbook  # noqa: E402


def sanitized_workbook(source: Path):
    payload = io.BytesIO()
    with zipfile.ZipFile(source) as zin, zipfile.ZipFile(
        payload, "w", zipfile.ZIP_DEFLATED
    ) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/styles.xml":
                text = data.decode("utf-8")
                text = text.replace(
                    "<fill/>",
                    '<fill><patternFill patternType="none"/></fill>',
                )
                data = text.encode("utf-8")
            zout.writestr(item, data)
    payload.seek(0)
    return load_workbook(payload, read_only=True, data_only=True)


def text(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value).strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, type=Path)
    parser.add_argument("--sheet", help="Sheet name; defaults to the first sheet")
    parser.add_argument("--owner")
    parser.add_argument("--ids", type=Path, help="Optional id list; first 'id' line is ignored")
    parser.add_argument("--ids-out", required=True, type=Path)
    parser.add_argument("--json-out", required=True, type=Path)
    args = parser.parse_args()

    if not args.owner and not args.ids:
        raise SystemExit("Specify --owner or --ids")
    if args.owner and args.ids:
        raise SystemExit("Specify only one of --owner or --ids")

    workbook = sanitized_workbook(args.xlsx)
    sheet = args.sheet or workbook.sheetnames[0]
    if sheet not in workbook.sheetnames:
        raise SystemExit(
            f"Sheet {sheet!r} not found; available: {workbook.sheetnames}"
        )

    rows = list(workbook[sheet].iter_rows(values_only=True))
    if not rows:
        raise SystemExit("Workbook sheet is empty")

    owners = Counter(text(row[1]) for row in rows[1:])
    if args.ids:
        wanted = [
            line.strip()
            for line in args.ids.read_text(encoding="utf-8").splitlines()
            if line.strip() and line.strip().lower() != "id"
        ]
        wanted_set = set(wanted)
        with_id = {
            text(row[0]): row for row in rows[1:] if text(row[0]) in wanted_set
        }
        target = [with_id[item_id] for item_id in wanted if item_id in with_id]
        missing = [item_id for item_id in wanted if item_id not in with_id]
        selection = f"ids={len(wanted)}, matched={len(target)}, missing={len(missing)}"
    else:
        target = [row for row in rows[1:] if text(row[1]) == args.owner]
        missing = []
        selection = f"owner={args.owner}: {len(target)}"
    items = [
        {
            "id": text(row[0]),
            "owner": text(row[1]),
            "url": text(row[2]),
            "status": text(row[3]),
            "title": text(row[5]),
            "authors": text(row[6]),
            "submitted": text(row[7]),
            "domain": text(row[8]),
        }
        for row in target
    ]

    args.ids_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.ids_out.write_text(
        "id\n" + "".join(f"{item['id']}\n" for item in items),
        encoding="utf-8",
    )
    args.json_out.write_text(
        json.dumps(items, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )

    print(f"sheet: {sheet!r}")
    print(f"rows: {len(rows) - 1}")
    print(f"owners: {owners.most_common()}")
    print(selection)
    if missing:
        print(f"missing_ids: {missing[:50]}")
    print(f"domains: {Counter(item['domain'] for item in items).most_common()}")
    item_ids = [item["id"] for item in items]
    preview = item_ids if len(item_ids) <= 30 else item_ids[:20] + ["..."] + item_ids[-10:]
    print(f"ids: {preview}")
    print(f"wrote: {args.ids_out}")
    print(f"wrote: {args.json_out}")


if __name__ == "__main__":
    main()
