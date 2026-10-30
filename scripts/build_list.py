"""从 id 清单 + 10月论文采集-6.xlsx 生成下载清单（id / DOI / 标题）。

用法:
  python scripts\\build_list.py --ids newlist.txt --start 600 --count 200 --out newlist3_papers.json
  python scripts\\build_list.py --ids newlist21.txt --all --out newlist21_papers.json

依赖: openpyxl（已装在项目内 .local_libs；运行时需要 PYTHONPATH=.local_libs）
"""
import argparse
import json
import os
import sys
import zipfile
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".local_libs"))

from openpyxl import load_workbook  # noqa: E402

XLSX = os.path.join(ROOT, "data", "inputs", "10月论文采集-6.xlsx")
CLEAN = os.path.join(ROOT, "state", "xlsx_clean_6.xlsx")


def sanitize(src, dst):
    """原表里有个空 <fill/> 节点会让 openpyxl 报错，这里做个兼容副本。"""
    if os.path.exists(dst):
        return
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/styles.xml":
                text = data.decode("utf-8").replace("<fill/>", '<fill><patternFill patternType="none"/></fill>')
                data = text.encode("utf-8")
            zout.writestr(item, data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", required=True, help="id 清单 txt（每行一个 id，可有表头）")
    ap.add_argument("--all", action="store_true", help="取全部 id")
    ap.add_argument("--start", type=int, default=0, help="从第几个开始（0 基）")
    ap.add_argument("--count", type=int, default=200, help="取多少个")
    ap.add_argument("--out", required=True, help="输出 json")
    args = ap.parse_args()

    ids = [l.strip() for l in open(args.ids, encoding="utf-8") if l.strip()]
    ids = [i for i in ids if i.lower() != "id"]
    picked = ids if args.all else ids[args.start:args.start + args.count]
    print(f"来源 {os.path.basename(args.ids)}：取 {len(picked)} 个，示例 {picked[:3]} … {picked[-2:]}")

    sanitize(XLSX, CLEAN)
    wb = load_workbook(CLEAN, read_only=True, data_only=True)
    ws = wb["Result 1"]
    want = set(picked)
    found = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        sid = str(row[0])
        if sid in want:
            found[sid] = {
                "id": sid, "owner": row[1], "url": row[2], "status": row[3],
                "title": row[5], "authors": row[6],
                "submitted": str(row[7]) if row[7] else "", "domain": row[8],
            }

    missing = [i for i in picked if i not in found]
    items = [found[i] for i in picked if i in found]
    print("命中:", len(items), " 缺失:", len(missing), missing[:10])
    print("域名分布:", Counter(x["domain"] for x in items).most_common(6))
    json.dump(items, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("已写出:", args.out)


if __name__ == "__main__":
    main()
