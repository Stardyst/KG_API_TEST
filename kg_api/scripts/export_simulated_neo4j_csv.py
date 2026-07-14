import csv
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from kg_api.graph_store import GraphStore


OUT_DIR = ROOT / "output" / "simulated_neo4j_import"


def main() -> None:
    store = GraphStore(ROOT)
    store.load()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    events_path = OUT_DIR / "simulated_events.csv"
    nodes_path = OUT_DIR / "simulated_nodes.csv"
    rels_path = OUT_DIR / "simulated_relationships.csv"
    cypher_path = OUT_DIR / "simulated_import.cypher"
    readme_path = OUT_DIR / "README.md"

    simulated_nodes = [node for node in store.nodes.values() if str(node.get("id", "")).startswith("entity_req_")]
    simulated_ids = {node["id"] for node in simulated_nodes}
    simulated_rels = [link for link in store.links if link.get("target") in simulated_ids]
    simulated_event_ids = sorted({link["source"] for link in simulated_rels})
    simulated_events = [store.nodes[event_id] for event_id in simulated_event_ids]

    with events_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(
            file,
            fieldnames=[
                "id:ID",
                "name",
                "event_type",
                "folder_name",
                "local_task_id",
                "source_file",
                "raw_text",
                "description",
                ":LABEL",
            ],
        )
        writer.writeheader()
        for node in simulated_events:
            properties = node.get("properties", {})
            writer.writerow(
                {
                    "id:ID": node.get("id", ""),
                    "name": node.get("name", ""),
                    "event_type": properties.get("event_type", ""),
                    "folder_name": properties.get("folder_name", ""),
                    "local_task_id": properties.get("local_task_id", ""),
                    "source_file": properties.get("source_file", ""),
                    "raw_text": properties.get("raw_text", ""),
                    "description": node.get("description", ""),
                    ":LABEL": "Event",
                }
            )

    with nodes_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=["id:ID", "name", "ontName", "description", ":LABEL"])
        writer.writeheader()
        for node in simulated_nodes:
            writer.writerow(
                {
                    "id:ID": node.get("id", ""),
                    "name": node.get("name", ""),
                    "ontName": node.get("ontName", ""),
                    "description": node.get("description", ""),
                    ":LABEL": "Entity",
                }
            )

    with rels_path.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=[":START_ID", ":END_ID", "label", ":TYPE"])
        writer.writeheader()
        for link in simulated_rels:
            writer.writerow(
                {
                    ":START_ID": link.get("source", ""),
                    ":END_ID": link.get("target", ""),
                    "label": link.get("label", "包含实体"),
                    ":TYPE": "HAS_ENTITY",
                }
            )

    cypher_path.write_text(
        "\n".join(
            [
                "// 在 Neo4j Browser 中执行前，请将 CSV 文件放入 Neo4j import 目录。",
                "LOAD CSV WITH HEADERS FROM 'file:///simulated_events.csv' AS row",
                "MATCH (event:Event {id: row.`id:ID`})",
                "SET event.name = row.name, event.event_type = row.event_type,",
                "    event.folder_name = row.folder_name, event.local_task_id = row.local_task_id,",
                "    event.source_file = row.source_file, event.raw_text = row.raw_text,",
                "    event.description = row.description;",
                "",
                "LOAD CSV WITH HEADERS FROM 'file:///simulated_nodes.csv' AS row",
                "MERGE (n:Entity {id: row.`id:ID`})",
                "SET n.name = row.name, n.ontName = row.ontName, n.description = row.description;",
                "",
                "LOAD CSV WITH HEADERS FROM 'file:///simulated_relationships.csv' AS row",
                "MATCH (start {id: row.`:START_ID`})",
                "MATCH (end {id: row.`:END_ID`})",
                "MERGE (start)-[r:HAS_ENTITY]->(end)",
                "SET r.label = row.label;",
                "",
            ]
        ),
        encoding="utf-8",
    )

    readme_path.write_text(
        "\n".join(
            [
                "# 课题要求补充字段 Neo4j 导入包",
                "",
                "本包包含接口运行时补充字段对应的 Neo4j 导入 CSV。",
                "",
                "文件：",
                "",
                "- `simulated_events.csv`：需要更新文本的现有事件节点。",
                "- `simulated_nodes.csv`：补充实体节点。",
                "- `simulated_relationships.csv`：现有事件节点到补充实体节点的 `HAS_ENTITY` 关系。",
                "- `simulated_import.cypher`：Neo4j Browser 导入语句。",
                "",
                "注意：事件 CSV 通过事件 ID 匹配已有 `Event` 节点，只更新属性，不创建新的事件节点。",
                "",
                f"事件数：{len(simulated_events)}",
                f"节点数：{len(simulated_nodes)}",
                f"关系数：{len(simulated_rels)}",
                "",
            ]
        ),
        encoding="utf-8",
    )

    print(
        f"events={len(simulated_events)} nodes={len(simulated_nodes)} "
        f"relationships={len(simulated_rels)} output={OUT_DIR}"
    )


if __name__ == "__main__":
    main()
