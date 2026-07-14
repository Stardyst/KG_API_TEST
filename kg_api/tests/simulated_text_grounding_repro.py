from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from kg_api.graph_store import GraphStore


def main() -> None:
    store = GraphStore(ROOT)
    store.load()

    checked = 0
    missing = []
    for event_id, entity_ids in store.entities_by_event.items():
        event_node = store.nodes.get(event_id, {})
        event_properties = event_node.get("properties", {})
        event_text = "\n".join(
            [
                str(event_properties.get("raw_text") or ""),
                str(event_node.get("description") or ""),
            ]
        )
        for entity_id in entity_ids:
            if not entity_id.startswith("entity_req_"):
                continue
            entity_node = store.nodes.get(entity_id, {})
            entity_properties = entity_node.get("properties", {})
            field = str(entity_properties.get("entity_type") or "")
            value = str(entity_properties.get("text") or entity_node.get("name") or "").strip()
            checked += 1
            if value and value not in event_text:
                missing.append({"事件ID": event_id, "字段": field, "实体值": value})

    print({"检查实体数": checked, "缺少文本依据数": len(missing), "示例": missing[:5]})
    if checked == 0:
        raise AssertionError("没有找到需要检查的补充实体")
    if missing:
        raise AssertionError("存在没有写入所属事件文本的补充实体")


if __name__ == "__main__":
    main()
