import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set


class GraphStoreError(ValueError):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.error_type = error_type
        self.message = message


class GraphStore:
    def __init__(self, root: Path):
        self.root = root
        self.graph_path = root / "kg_source" / "exports" / "full_static_graph.json"
        self.field_index_path = root / "kg_source" / "reports" / "event_field_index.json"

        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.links: List[Dict[str, Any]] = []
        self.events_by_type: Dict[str, Set[str]] = defaultdict(set)
        self.entities_by_event: Dict[str, Set[str]] = defaultdict(set)
        self.events_by_entity: Dict[str, Set[str]] = defaultdict(set)
        self.event_type_node_by_name: Dict[str, str] = {}
        self.event_type_fields: Dict[str, List[str]] = {}
        self.event_type_field_set: Dict[str, Set[str]] = {}
        self.event_links_by_type: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

    def load(self) -> None:
        if not self.graph_path.exists():
            raise FileNotFoundError(f"Graph file not found: {self.graph_path}")
        if not self.field_index_path.exists():
            raise FileNotFoundError(f"Field index file not found: {self.field_index_path}")

        graph = json.loads(self.graph_path.read_text(encoding="utf-8"))
        self.nodes = {node["id"]: node for node in graph.get("staticNodes", [])}
        self.links = graph.get("staticLinks", [])

        field_index = json.loads(self.field_index_path.read_text(encoding="utf-8"))
        for item in field_index:
            event_type = item["事件类型"]
            fields = [field["字段"] for field in item.get("实体字段", [])]
            self.event_type_fields[event_type] = fields
            self.event_type_field_set[event_type] = set(fields)

        for node_id, node in self.nodes.items():
            labels = set(node.get("labels", []))
            props = node.get("properties", {})
            if "Event" in labels:
                event_type = props.get("event_type")
                if event_type:
                    self.events_by_type[event_type].add(node_id)
            elif "EventType" in labels:
                name = props.get("name") or node.get("name")
                if name:
                    self.event_type_node_by_name[name] = node_id

        for link in self.links:
            link_type = link.get("type")
            source = link.get("source")
            target = link.get("target")
            if link_type == "HAS_ENTITY":
                self.entities_by_event[source].add(target)
                self.events_by_entity[target].add(source)
            elif link_type == "BELONGS_TO":
                source_node = self.nodes.get(source, {})
                event_type = source_node.get("properties", {}).get("event_type")
                if event_type:
                    self.event_links_by_type[event_type].append(link)

    def event_types(self) -> List[str]:
        return sorted(self.events_by_type.keys())

    def ensure_event_type(self, event_type: str) -> None:
        if not event_type:
            raise GraphStoreError("参数错误", "事件类型不能为空")
        if event_type not in self.events_by_type:
            raise GraphStoreError("事件类型不存在", f"事件类型【{event_type}】不存在")

    def fields_for_event_type(self, event_type: str) -> List[str]:
        self.ensure_event_type(event_type)
        return self.event_type_fields.get(event_type, [])

    def candidate_values(self, event_type: str, field: str) -> List[Dict[str, Any]]:
        self.ensure_event_type(event_type)
        self.ensure_field(event_type, field)

        value_events: Dict[str, Set[str]] = defaultdict(set)
        for event_id in self.events_by_type[event_type]:
            for entity_id in self.entities_by_event.get(event_id, set()):
                node = self.nodes.get(entity_id, {})
                props = node.get("properties", {})
                if props.get("entity_type") == field:
                    text = str(props.get("text") or node.get("name") or "").strip()
                    if text:
                        value_events[text].add(event_id)

        values = []
        all_value_events = list(value_events.items())
        for value, direct_events in all_value_events:
            matched_events = set(direct_events)
            for other_value, other_events in all_value_events:
                if value != other_value and value in other_value:
                    matched_events.update(other_events)
            values.append({"值": value, "命中次数": len(matched_events)})
        values.sort(key=lambda item: (-item["命中次数"], item["值"]))
        return values

    def query(self, event_type: str, filters: Dict[str, Any]) -> Dict[str, Any]:
        self.ensure_event_type(event_type)
        filters = filters or {}
        for field in filters:
            self.ensure_field(event_type, field)

        matched_events = sorted(
            event_id
            for event_id in self.events_by_type[event_type]
            if self.event_matches(event_id, filters)
        )

        node_ids: Set[str] = set(matched_events)
        event_type_node_id = self.event_type_node_by_name.get(event_type)
        if event_type_node_id:
            node_ids.add(event_type_node_id)
        for event_id in matched_events:
            node_ids.update(self.entities_by_event.get(event_id, set()))

        result_links = [
            link
            for link in self.links
            if link.get("source") in node_ids and link.get("target") in node_ids
        ]

        result_nodes = [self.public_node(self.nodes[node_id]) for node_id in sorted(node_ids) if node_id in self.nodes]
        public_links = [self.public_link(link) for link in result_links]
        event_list = [self.public_event(self.nodes[event_id]) for event_id in matched_events]

        return {
            "事件类型": event_type,
            "命中事件数": len(matched_events),
            "节点数": len(result_nodes),
            "关系数": len(public_links),
            "命中事件列表": event_list,
            "staticNodes": result_nodes,
            "staticLinks": public_links,
        }

    def ensure_field(self, event_type: str, field: str) -> None:
        if not field:
            raise GraphStoreError("参数错误", "字段不能为空")
        if field not in self.event_type_field_set.get(event_type, set()):
            raise GraphStoreError("筛选字段不存在", f"字段【{field}】不属于事件类型【{event_type}】")

    def event_matches(self, event_id: str, filters: Dict[str, Any]) -> bool:
        for field, expected in filters.items():
            values = self.normalize_filter_values(expected)
            if not values:
                continue
            if not self.event_matches_field(event_id, field, values):
                return False
        return True

    def event_matches_field(self, event_id: str, field: str, values: List[str]) -> bool:
        for entity_id in self.entities_by_event.get(event_id, set()):
            node = self.nodes.get(entity_id, {})
            props = node.get("properties", {})
            if props.get("entity_type") != field:
                continue
            text = str(props.get("text") or node.get("name") or "")
            if any(value in text for value in values):
                return True
        return False

    @staticmethod
    def normalize_filter_values(value: Any) -> List[str]:
        if value is None:
            return []
        if isinstance(value, list):
            return [str(item).strip() for item in value if str(item).strip()]
        text = str(value).strip()
        return [text] if text else []

    @staticmethod
    def public_node(node: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": node.get("id", ""),
            "name": node.get("name", ""),
            "ontoid": node.get("ontoid", ""),
            "ontName": node.get("ontName", ""),
            "description": node.get("description", ""),
        }

    @staticmethod
    def public_link(link: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": link.get("id", ""),
            "source": link.get("source", ""),
            "target": link.get("target", ""),
            "label": link.get("label", ""),
        }

    @staticmethod
    def public_event(node: Dict[str, Any]) -> Dict[str, Any]:
        props = node.get("properties", {})
        raw_text = str(props.get("raw_text") or "")
        return {
            "事件ID": node.get("id", ""),
            "本地任务ID": props.get("local_task_id", ""),
            "原始文件": props.get("source_file", ""),
            "原文摘要": raw_text[:180],
        }
