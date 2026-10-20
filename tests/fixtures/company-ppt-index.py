"""Small synthetic Doctor v7 index. Optional actual Doctor builder for local E2E."""
import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
source = root / "20261020-SRS素材样例.pptx"
source.write_bytes(b"synthetic text-index fixture; not a presentation for opening")
index = root / "index.db"
texts = ["SRS 信道估计\n通过导频观测得到上行信道，再据此选择接收权重。",
         "候选权重\n保留原始复数相位，不能把相反相位的信道直接平均。" + "完整正文。" * 450 + "完整页尾标记",
         "无关素材\n会议通知示例"]
if len(sys.argv) > 2:
    sys.path.insert(0, str(Path(sys.argv[2]) / "src"))
    from pptx_finder import db
    from pptx_finder.text_tokenize import tokenize
    conn = db.connect(index)
    db.init_db(conn)
    st = source.stat()
    fid = db.upsert_file(conn, path=str(source), name=source.name, ext=".pptx", size=st.st_size,
                        mtime=st.st_mtime, content_hash=hashlib.sha256(source.read_bytes()).hexdigest(),
                        page_count=len(texts), status="ok", error="", indexed_at=1.0)
    db.replace_pages(conn, fid, [(i, text, tokenize(text)) for i, text in enumerate(texts, 1)])
else:
    # Schema and character/trigram token layout match Doctor index v7.
    conn = sqlite3.connect(index)
    conn.executescript("""
    CREATE TABLE files(id INTEGER PRIMARY KEY, path TEXT, name TEXT, name_norm TEXT, ext TEXT,
      size INTEGER, mtime REAL, content_hash TEXT, page_count INTEGER, status TEXT, indexed_at REAL);
    CREATE TABLE pages_raw(file_id INTEGER, page_no INTEGER, raw_text TEXT, PRIMARY KEY(file_id,page_no));
    CREATE VIRTUAL TABLE pages_fts USING fts5(content, file_id UNINDEXED, page_no UNINDEXED);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES('index_version','7');
    """)
    st = source.stat()
    conn.execute("INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                 (1, str(source), source.name, source.name.casefold(), ".pptx", st.st_size, st.st_mtime,
                  hashlib.sha256(source.read_bytes()).hexdigest(), len(texts), "ok", 1.0))
    for i, text in enumerate(texts, 1):
        base = re.findall(r"[a-z0-9]+|[㐀-鿿]|[^\W_]", text.casefold())
        tris = [t[k:k+3] for t in base if t.isascii() and len(t) >= 3 for k in range(len(t)-2)]
        conn.execute("INSERT INTO pages_raw VALUES(?,?,?)", (1, i, text))
        conn.execute("INSERT INTO pages_fts VALUES(?,?,?)", (" ".join(base + tris), 1, i))
conn.commit()
conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
conn.close()
print(json.dumps({"db": str(index), "pages": len(texts), "actualDoctorBuilder": len(sys.argv) > 2}))
