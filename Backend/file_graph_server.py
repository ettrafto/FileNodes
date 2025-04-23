import os, json, datetime
from pathlib import Path
from collections import namedtuple
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

# ── 1. Data model ──────────────────────────────────────────────────────────────
FileInfo = namedtuple(
    "FileInfo",
    ["path", "size", "parent_dir", "file_type", "size_on_disk", "created", "accessed"],
)

def _stat_file(path: Path, root: Path) -> FileInfo | None:
    try:
        st = path.stat()
    except (OSError, FileNotFoundError):
        return None
    return FileInfo(
        path=str(path),
        size=st.st_size,
        parent_dir=str(path.parent.relative_to(root)) or ".",
        file_type=path.suffix.lower().lstrip(".") or "<none>",
        size_on_disk=getattr(st, "st_blocks", 0) * 512,
        created=datetime.datetime.fromtimestamp(st.st_ctime).isoformat(),
        accessed=datetime.datetime.fromtimestamp(st.st_atime).isoformat(),
    )

def scan_directory_iter(root: Path, workers: int = 8):
    root = Path(root).expanduser()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = []
        for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
            dirnames[:]  = [d for d in dirnames  if not d.startswith(".")]
            filenames[:] = [f for f in filenames if not f.startswith(".")]
            base = Path(dirpath)
            for name in filenames:
                full = base / name
                if full.is_symlink(): continue
                futures.append(ex.submit(_stat_file, full, root))
        for fut in as_completed(futures):
            if info := fut.result():
                yield info

# ── 2. Directory picker ─────────────────────────────────────────────────────────
def pick_directory_interactive(default: str | None = None) -> Path:
    default = Path(default or Path.home()).expanduser()
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk(); root.withdraw()
        chosen = filedialog.askdirectory(initialdir=default,
                                         title="Select directory to crawl")
        root.destroy()
        if chosen:
            return Path(chosen)
    except Exception:
        pass

    # CLI fallback
    while True:
        txt = input(f"Directory to crawl [{default}]: ").strip() or str(default)
        p = Path(txt).expanduser()
        if p.is_dir():
            return p
        print(f"✖  '{txt}' is not a valid directory.")

# ── 3. FastAPI app & state ───────────────────────────────────────────────────────
app = FastAPI()
app.state.test_root = pick_directory_interactive()

@app.get("/")
async def root():
    return {
        "status": "ok",
        "ws_endpoint": f"/ws?root={app.state.test_root}"
    }

@app.websocket("/ws")
async def crawl_ws(ws: WebSocket, root: str | None = None, workers: int = 8):
    await ws.accept()
    # if root not supplied by client, use our test_root
    scan_root = Path(root or app.state.test_root)
    try:
        for info in scan_directory_iter(scan_root, workers):
            await ws.send_text(json.dumps(info._asdict()))
        await ws.close(code=1000)
    except WebSocketDisconnect:
        return

if __name__ == "__main__":
    # no root_path kwarg here!
    uvicorn.run("file_graph_server:app", host="0.0.0.0", port=8000, reload=True)
