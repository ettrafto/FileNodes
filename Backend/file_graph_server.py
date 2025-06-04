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
                if full.is_symlink():
                    continue
                futures.append(ex.submit(_stat_file, full, root))
        for fut in as_completed(futures):
            if info := fut.result():
                yield info

# ── 2. FastAPI app ─────────────────────────────────────────────────────────────
app = FastAPI()

@app.get("/")
async def root():
    return {
        "status": "ok",
        "ws_endpoint": "/ws"
    }

@app.websocket("/ws")
async def crawl_ws(ws: WebSocket, workers: int = 8):
    await ws.accept()
    try:
        # Wait for a message from the client specifying the root directory
        msg = await ws.receive_text()
        data = json.loads(msg)
        if data.get("type") != "start" or "root" not in data:
            await ws.send_text(json.dumps({"error": "Expected message of type 'start' with 'root'"}))
            await ws.close(code=1003)
            return

        scan_root = Path(data["root"]).expanduser()
        if not scan_root.exists() or not scan_root.is_dir():
            await ws.send_text(json.dumps({"error": f"Invalid directory: {scan_root}"}))
            await ws.close(code=1003)
            return

        # Stream file info
        for info in scan_directory_iter(scan_root, workers):
            await ws.send_text(json.dumps(info._asdict()))
        await ws.close(code=1000)

    except WebSocketDisconnect:
        return
    except Exception as e:
        await ws.send_text(json.dumps({"error": str(e)}))
        await ws.close(code=1011)

# ── 3. Run app ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("file_graph_server:app", host="0.0.0.0", port=8000, reload=True)
