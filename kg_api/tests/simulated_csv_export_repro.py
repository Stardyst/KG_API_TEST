import csv
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from kg_api.graph_store import GraphStore
from kg_api.scripts.export_simulated_neo4j_csv import OUT_DIR, main as export_csv


def main() -> None:
    export_csv()

    events_path = OUT_DIR / "simulated_events.csv"
    if not events_path.exists():
        raise AssertionError("没有生成补充事件 CSV")

    with events_path.open("r", encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))
    if not rows:
        raise AssertionError("补充事件 CSV 为空")

    event_ids = [row["id:ID"] for row in rows]
    if len(event_ids) != len(set(event_ids)):
        raise AssertionError("补充事件 CSV 存在重复事件 ID")

    store = GraphStore(ROOT)
    store.load()
    expected_event_ids = {
        link["source"]
        for link in store.links
        if str(link.get("target", "")).startswith("entity_req_")
    }
    if set(event_ids) != expected_event_ids:
        raise AssertionError("补充事件 CSV 没有完整覆盖挂载补充实体的事件")

    row_by_id = {row["id:ID"]: row for row in rows}
    missing_values = []
    for link in store.links:
        entity_id = str(link.get("target", ""))
        if not entity_id.startswith("entity_req_"):
            continue
        event_id = link["source"]
        entity = store.nodes[entity_id]
        value = str(entity.get("properties", {}).get("text") or entity.get("name") or "")
        event_text = "\n".join([row_by_id[event_id]["raw_text"], row_by_id[event_id]["description"]])
        if value not in event_text:
            missing_values.append({"事件ID": event_id, "实体值": value})
    if missing_values:
        raise AssertionError(f"补充事件 CSV 缺少实体文本依据：{missing_values[:5]}")

    cypher = (OUT_DIR / "simulated_import.cypher").read_text(encoding="utf-8")
    if "MATCH (event:Event {id: row.`id:ID`})" not in cypher:
        raise AssertionError("导入语句没有通过事件 ID 匹配已有事件节点")
    if "MERGE (event:Event" in cypher or "CREATE (event:Event" in cypher:
        raise AssertionError("导入语句可能重复创建事件节点")

    print({"补充事件数": len(rows), "缺少文本依据数": len(missing_values), "事件ID唯一": True})


if __name__ == "__main__":
    main()
