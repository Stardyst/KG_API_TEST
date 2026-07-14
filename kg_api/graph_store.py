import json
import re
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
        self.simulated_graph_path = root / "kg_api" / "simulated_requirement_graph.json"

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

        self.add_simulated_requirement_data()

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

    def full_export(self) -> Dict[str, Any]:
        return {
            "事件类型数": len(self.event_types()),
            "节点数": len(self.nodes),
            "关系数": len(self.links),
            "staticNodes": [self.public_node(node) for node in self.nodes.values()],
            "staticLinks": [self.public_link(link) for link in self.links],
        }

    def blacklist_graph(self) -> Dict[str, Any]:
        entries, matched_event_ids = self.build_blacklist_data()
        preview_entries = entries[:180]
        nodes: Dict[str, Dict[str, Any]] = {}
        links: List[Dict[str, Any]] = []

        def add_node(node_id: str, name: str, ont_name: str, description: str = "") -> None:
            nodes.setdefault(
                node_id,
                {
                    "id": node_id,
                    "name": name,
                    "ontoid": "",
                    "ontName": ont_name,
                    "description": description,
                },
            )

        for entry in preview_entries:
            event_type_id = f"black_event_type_{self.safe_id(entry['事件类型'])}"
            ship_id = f"black_ship_{self.safe_id(entry['船名'])}"
            add_node(event_type_id, entry["事件类型"], "违法事件类型")
            add_node(ship_id, entry["船名"], "船名")
            links.append(
                {
                    "id": f"black_link_{event_type_id}_{ship_id}",
                    "source": event_type_id,
                    "target": ship_id,
                    "label": "涉及船名",
                }
            )
        return {
            "结果类型": "黑名单图谱",
            "事件类型": "违法船舶黑名单",
            "命中事件数": len(matched_event_ids),
            "节点数": len(nodes),
            "关系数": len(links),
            "黑名单条目": entries,
            "命中事件列表": [],
            "staticNodes": list(nodes.values()),
            "staticLinks": links,
        }

    def add_simulated_requirement_data(self) -> None:
        if not self.simulated_graph_path.exists():
            return
        config = json.loads(self.simulated_graph_path.read_text(encoding="utf-8"))
        field_configs = config.get("字段", [])
        if not isinstance(field_configs, list):
            return

        existing_entity_values: Dict[str, Set[tuple]] = defaultdict(set)
        for link in self.links:
            if link.get("type") != "HAS_ENTITY":
                continue
            entity = self.nodes.get(link.get("target"), {})
            properties = entity.get("properties", {})
            field = str(properties.get("entity_type") or entity.get("ontName") or "").strip()
            value = str(properties.get("text") or entity.get("name") or "").strip()
            if field and value:
                existing_entity_values[link.get("source")].add((field, value))

        event_requirement_values: Dict[str, List[Dict[str, str]]] = defaultdict(list)
        for event_type in self.event_types():
            event_ids = sorted(self.events_by_type[event_type])
            for event_index, event_id in enumerate(event_ids):
                for field_index, field_config in enumerate(field_configs):
                    field = field_config.get("字段")
                    if not field:
                        continue
                    if not self.should_attach_simulated_field(event_type, event_index, field_index):
                        continue
                    values = field_config.get("候选值", [])
                    if not values:
                        continue
                    value = str(values[(event_index + field_index) % len(values)])
                    if (field, value) in existing_entity_values[event_id]:
                        continue
                    self.event_type_field_set[event_type].add(field)
                    if field not in self.event_type_fields.setdefault(event_type, []):
                        self.event_type_fields[event_type].append(field)
                    event_requirement_values[event_id].append({"字段": field, "值": value})
                    existing_entity_values[event_id].add((field, value))
                    entity_id = f"entity_req_{self.safe_id(event_id)}_{field_index}"
                    self.nodes[entity_id] = {
                        "id": entity_id,
                        "name": value,
                        "ontoid": "",
                        "ontName": field,
                        "description": "",
                        "labels": ["Entity"],
                        "properties": {
                            "entity_type": field,
                            "text": value,
                        },
                    }
                    self.links.append(
                        {
                            "id": f"rel_req_{self.safe_id(event_id)}_{field_index}",
                            "source": event_id,
                            "target": entity_id,
                            "type": "HAS_ENTITY",
                            "label": "包含实体",
                        }
                    )

        for event_id, requirement_values in event_requirement_values.items():
            self.attach_requirement_text(event_id, requirement_values)

    def attach_requirement_text(self, event_id: str, requirement_values: List[Dict[str, str]]) -> None:
        event_node = self.nodes.get(event_id)
        if not event_node:
            return

        phrases = {
            "船东": "涉事船舶船东为{value}",
            "船舶管理公司人员": "船舶管理公司相关人员为{value}",
            "船舶驾引人员": "船舶驾引人员为{value}",
            "船上乘客": "船上乘客包括{value}",
            "工程船": "现场涉及工程船{value}",
            "交通流量": "事发水域交通流量为{value}",
            "交通流分布": "交通流分布表现为{value}",
            "气象": "现场气象条件为{value}",
            "水文": "现场水文条件为{value}",
            "港口": "关联港口为{value}",
            "航道": "关联航道为{value}",
            "锚地": "关联锚地为{value}",
            "渔区": "关联渔区为{value}",
            "地方条例": "处置依据包括{value}",
        }
        details = []
        for item in requirement_values:
            field = item["字段"]
            value = item["值"]
            template = phrases.get(field, f"{field}为{{value}}")
            details.append(template.format(value=value))
        paragraph = "案情记录显示，" + "；".join(details) + "。"

        properties = event_node.setdefault("properties", {})
        raw_text = str(properties.get("raw_text") or "").strip()
        description = str(event_node.get("description") or "").strip()
        properties["raw_text"] = "\n".join(text for text in (paragraph, raw_text) if text)
        event_node["description"] = "\n".join(text for text in (paragraph, description) if text)

    @staticmethod
    def should_attach_simulated_field(event_type: str, event_index: int, field_index: int) -> bool:
        if event_index >= 18:
            return False
        if "碰撞" in event_type:
            preferred = {6, 7, 8, 9, 10, 11, 12}
        elif "采砂" in event_type or "倾废" in event_type:
            preferred = {4, 8, 9, 10, 11, 13}
        elif "驻留" in event_type or "停泊" in event_type or "抛锚" in event_type:
            preferred = {7, 8, 9, 10, 11, 12, 13}
        elif "走私" in event_type or "偷渡" in event_type or "搭靠" in event_type:
            preferred = {0, 1, 2, 3, 5, 10, 13}
        elif "超速" in event_type or "徘徊" in event_type or "入侵" in event_type:
            preferred = {6, 7, 8, 9, 10, 11}
        else:
            preferred = set()
        return field_index in preferred and (event_index + field_index) % 7 == 0

    def build_blacklist_data(self):
        ship_events: Dict[tuple, Set[str]] = defaultdict(set)
        generic_ship_terms = {
            "船舶",
            "渔船",
            "货船",
            "油船",
            "工程船",
            "采砂船",
            "运油船",
            "锚泊船",
            "过驳船",
            "快艇",
            "小艇",
        }

        for event_type, event_ids in self.events_by_type.items():
            for event_id in event_ids:
                event_ships: Set[str] = set()
                for entity_id in self.entities_by_event.get(event_id, set()):
                    node = self.nodes.get(entity_id, {})
                    props = node.get("properties", {})
                    entity_type = props.get("entity_type") or node.get("ontName") or ""
                    text = str(props.get("text") or node.get("name") or "").strip()
                    if not text:
                        continue
                    if entity_type in {"船名", "船舶"}:
                        for ship_name in self.extract_ship_names(text):
                            if ship_name not in generic_ship_terms and len(ship_name) >= 2:
                                event_ships.add(ship_name)

                for ship_name in event_ships:
                    key = (event_type, ship_name)
                    ship_events[key].add(event_id)

        entries = [
            {"事件类型": event_type, "船名": ship_name}
            for event_type, ship_name in ship_events
        ]
        entries.sort(
            key=lambda item: (
                -len(ship_events[(item["事件类型"], item["船名"])]),
                item["事件类型"],
                item["船名"],
            )
        )
        matched_event_ids = set().union(*ship_events.values()) if ship_events else set()
        return entries, matched_event_ids

    @staticmethod
    def extract_mmsi(text: str) -> Set[str]:
        values = set(re.findall(r"(?<!\d)\d{9}(?!\d)", text))
        values.update(match.group(1) for match in re.finditer(r"MMSI[^\d]{0,12}(\d{6,12})", text, re.I))
        return {value for value in values if len(value) == 9}

    @staticmethod
    def extract_ship_names(text: str) -> Set[str]:
        quoted_names = {
            GraphStore.clean_ship_name(item)
            for item in re.findall(r"[“\"']([^”\"']{2,30})[”\"'](?:轮|船|艇|号)", text)
        }
        structured_names = {
            GraphStore.clean_ship_name(item)
            for item in re.findall(r"([\u4e00-\u9fa5A-Za-z0-9×·.-]{2,24})(?:轮|船|艇|号)", text)
        }
        cleaned = GraphStore.clean_ship_name(text)
        if GraphStore.looks_like_ship_name(cleaned):
            structured_names.add(cleaned)
        return {
            name
            for name in quoted_names
            if name and not GraphStore.is_non_ship_name(name)
        } | {
            name
            for name in structured_names
            if GraphStore.looks_like_ship_name(name)
        }

    @staticmethod
    def clean_ship_name(text: str) -> str:
        value = str(text).strip()
        value = re.sub(r"^(涉案|目标|嫌疑|违法|该|一艘|船名为|名为)", "", value)
        value = value.strip(" “”\"'，,。；;：:")
        value = re.sub(r"[“”\"']", "", value)
        value = re.sub(r"(轮|船|艇|渔|号)$", "", value)
        value = value.strip(" “”\"'，,。；;：:")
        if GraphStore.is_non_ship_name(value):
            return ""
        if len(value) > 30:
            return ""
        return value

    @staticmethod
    def looks_like_ship_name(value: str) -> bool:
        if not value or GraphStore.is_non_ship_name(value):
            return False
        if re.search(r"(粤|浙|鲁|闽|苏|沪|皖|桂|琼|辽|冀|津|渝|川|鄂|湘|赣|豫|粤港|港澳|中远|中海|中交|中建|浙舟|鲁荣渔|粤广州货|粤珠)", value):
            return True
        if re.search(r"[A-Za-z].*\d|\d.*[A-Za-z]", value):
            return True
        if re.search(r"[\u4e00-\u9fa5]{1,8}\d{1,8}$", value):
            return True
        return False

    @staticmethod
    def is_non_ship_name(value: str) -> bool:
        if not value:
            return True
        if GraphStore.is_public_service_ship_name(value):
            return True
        bad_keywords = [
            "航速",
            "航向",
            "船首向",
            "船艏向",
            "速度",
            "节",
            "度",
            "°",
            "吃水",
            "船长",
            "船宽",
            "长约",
            "宽约",
            "吨",
            "满载",
            "锚泊",
            "航行",
            "动态",
            "轨迹",
            "雷达",
            "AIS",
            "能见度",
            "风",
            "浪",
            "海速",
            "无名",
            "无证",
            "不知名",
        ]
        if any(keyword in value for keyword in bad_keywords):
            return True
        if re.fullmatch(r"[\d.]+", value):
            return True
        if re.fullmatch(r"x+", value, re.I):
            return True
        generic_terms = {
            "三无",
            "交通",
            "自备",
            "散货",
            "船舶",
            "渔船",
            "货船",
            "油船",
            "工程船",
            "采砂船",
            "运油船",
            "锚泊船",
            "过驳船",
            "快艇",
            "小艇",
            "公务船",
            "执法船",
            "运泥",
            "蚝排",
            "抓斗",
            "挖泥",
            "疏浚",
            "巡逻",
            "巡视",
            "执法",
        }
        return value in generic_terms

    @staticmethod
    def is_public_service_ship_name(value: str) -> bool:
        normalized = re.sub(r"\s+", "", str(value))
        service_markers = [
            "海巡",
            "海警",
            "渔政",
            "海监",
            "水警",
            "海关",
            "打私",
            "执法",
            "巡逻",
            "巡视",
            "消拖",
            "消防",
            "环保",
            "引航",
            "东海救",
            "南海救",
            "北海救",
            "护救",
            "公安",
            "搜救",
            "救援",
            "航标",
            "标巡",
            "军舰",
            "护卫舰",
            "海军",
        ]
        if any(marker in normalized for marker in service_markers):
            return True
        return bool(re.search(r"港引\d", normalized))

    @staticmethod
    def safe_id(value: str) -> str:
        return re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff-]+", "_", str(value))[:80]

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
