import json
from urllib.parse import quote
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .graph_store import GraphStore, GraphStoreError


ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = Path(__file__).resolve().parent / "static"

store = GraphStore(ROOT)
store.load()

app = FastAPI(title="知识图谱本地测试接口", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def error_response(error_type: str, message: str, status_code: int = 400) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"错误": True, "错误类型": error_type, "错误信息": message},
    )


@app.exception_handler(GraphStoreError)
async def graph_store_error_handler(request: Request, exc: GraphStoreError):
    return error_response(exc.error_type, exc.message)


@app.exception_handler(Exception)
async def general_error_handler(request: Request, exc: Exception):
    return error_response("服务器错误", str(exc), 500)


async def body_json(request: Request) -> Dict[str, Any]:
    try:
        data = await request.json()
    except Exception:
        data = {}
    if not isinstance(data, dict):
        raise GraphStoreError("参数错误", "请求体必须是 JSON 对象")
    return data


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/事件类型列表")
async def event_type_list():
    return {"事件类型列表": store.event_types()}


@app.post("/api/可筛选字段")
async def filter_fields(request: Request):
    data = await body_json(request)
    event_type = data.get("事件类型", "")
    return {"事件类型": event_type, "可筛选字段": store.fields_for_event_type(event_type)}


@app.post("/api/字段候选值")
async def field_candidates(request: Request):
    data = await body_json(request)
    event_type = data.get("事件类型", "")
    field = data.get("字段", "")
    return {"事件类型": event_type, "字段": field, "候选值": store.candidate_values(event_type, field)}


@app.post("/api/知识图谱查询")
async def graph_query(request: Request):
    data = await body_json(request)
    event_type = data.get("事件类型", "")
    filters = data.get("筛选条件", {})
    if not isinstance(filters, dict):
        raise GraphStoreError("参数错误", "筛选条件必须是 JSON 对象")
    return store.query(event_type, filters)


@app.post("/api/知识图谱下载")
async def graph_download(request: Request):
    result = await graph_query(request)
    filename = f"{result['事件类型']}_查询结果.json"
    encoded_filename = quote(filename)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    return Response(
        content=payload.encode("utf-8"),
        media_type="application/json; charset=utf-8",
        headers={
            "Content-Disposition": (
                f"attachment; filename=\"kg_query_result.json\"; filename*=UTF-8''{encoded_filename}"
            )
        },
    )


@app.get("/api/健康检查")
async def health_check():
    return {
        "状态": "正常",
        "事件类型数": len(store.event_types()),
        "节点数": len(store.nodes),
        "关系数": len(store.links),
    }
