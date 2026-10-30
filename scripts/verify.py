import json
import os
import re
import subprocess
import sys
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MANIFESTS = os.path.join(DATA, "manifests")
DOWNLOAD_ROOT = os.path.join(ROOT, "downloads")
PDFTOTEXT = r"C:\msys64\ucrt64\bin\pdftotext.exe"
PDFINFO = r"C:\msys64\ucrt64\bin\pdfinfo.exe"


def opt(name, default):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


def resolve_download_path(value):
    return value if os.path.isabs(value) else os.path.join(DOWNLOAD_ROOT, value)


LIST = opt("--list", os.path.join(MANIFESTS, "papers.json"))
DL = resolve_download_path(opt("--dir", "downloads_scidir"))
REPORT = opt("--report", os.path.join(ROOT, "state", "verify_report.csv"))


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").lower()
    s = re.sub(r"-\s*\n\s*", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def run(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        return r.stdout.decode("utf-8", "ignore")
    except Exception:
        return ""


items = json.load(open(LIST, encoding="utf-8"))
rows = []
stats = {"doi": 0, "title": 0, "unknown": 0, "missing": 0, "corrupt": 0}

for it in items:
    fid = it["id"]
    f = os.path.join(DL, f"{fid}.pdf")
    if not os.path.exists(f):
        stats["missing"] += 1
        rows.append((fid, "missing", 0, "", (it.get("title") or "")[:60]))
        continue
    size = os.path.getsize(f)
    head = open(f, "rb").read(5)
    if head != b"%PDF-":
        stats["corrupt"] += 1
        rows.append((fid, "corrupt", size, "bad header", (it.get("title") or "")[:60]))
        continue
    txt = run([PDFTOTEXT, "-f", "1", "-l", "1", f, "-"])
    n = norm(txt)
    doi_raw = (it.get("url") or "").split("doi.org/")[-1].strip().lower()
    doi = norm(doi_raw)
    title = norm(it.get("title") or "")
    if doi and len(doi) > 8 and doi in n:
        stats["doi"] += 1
        rows.append((fid, "ok_doi", size, "", ""))
    elif (
        "/" in doi_raw
        and (suffix := re.sub(r"[^a-z0-9]+", "", doi_raw.split("/", 1)[1]))
        and len(suffix) >= 10
        and suffix in re.sub(r"[^a-z0-9]+", "", txt.lower())
    ):
        stats["doi"] += 1
        rows.append((fid, "ok_doi_compact", size, "", ""))
    elif title and len(title) >= 40 and title[:60] in n:
        stats["title"] += 1
        rows.append((fid, "ok_title", size, "", ""))
    else:
        stats["unknown"] += 1
        snippet = re.sub(r"\s+", " ", txt.strip())[:70]
        rows.append((fid, "check", size, snippet, (it.get("title") or "")[:60]))

with open(REPORT, "w", encoding="utf-8-sig", newline="") as fh:
    fh.write("id,status,size,note,expected_title\n")
    for r in rows:
        fh.write(",".join('"' + str(x).replace('"', "'") + '"' for x in r) + "\n")

print("清单:", LIST)
print("目录:", DL)
print("清单总数:", len(items))
print("结果:", stats)
print("已下载合计:", stats["doi"] + stats["title"] + stats["unknown"])
print()
print("需要人工确认的:")
for r in rows:
    if r[1] in ("check", "corrupt", "missing"):
        print(" ", r)
print()
print("报告:", REPORT)
