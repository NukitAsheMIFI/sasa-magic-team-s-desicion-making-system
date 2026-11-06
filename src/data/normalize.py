import os
import json
import pandas as pd

# Технические поля исключаем сразу чтобы не ловить шум
EXCLUDE_PATHS = {
    "appData.request_id",
    "appData.createDateTime"
}

# Правила поиска ключа элемента для каждого типа массива
ARRAY_KEY_RULES = {
    "decisionResult.available_offers": lambda item: f"{item.get('product_id')}+{item.get('type')}",
    "decisionResult.product_trials": lambda item: str(item.get("product_id")),
    "decisionResult.product_trials.rules": lambda item: str(item.get("name")),
    "decisionResult.product_trials.scoring.scoreModels": lambda item: str(item.get("modelName")),
    "decisionResult.scoring": lambda item: str(item.get("modelName")),
    "ext_data": lambda item: str(item.get("body", {}).get("action", "")),
    "product_catalog": lambda item: f"{item.get('mfo_id')}+{item.get('product_id')}",
    "tariff_matrix": lambda item: f"{item.get('mfo_id')}+{item.get('product_id')}"
}

def get_bucket(val, path):
    if val is None or val == "":
        return ""
    try:
        num = float(val)
        if "score" in path.lower() or "scoring" in path.lower():
            if num <= 300: return "(0 - 300]"
            if num <= 600: return "(300 - 600]"
            return "(600 - 1000]"
        if "limit" in path.lower() or "amount" in path.lower():
            if num <= 100000: return "(0 - 100K]"
            if num <= 250000: return "(100K - 250K]"
            return "(250K+]"
    except (ValueError, TypeError):
        pass
    return str(val)

def _emit_row(rows, app_id, source, path_segments, array_keys, value):
    full_path = ".".join(path_segments)
    if full_path in EXCLUDE_PATHS:
        return

    prefix = path_segments[0] if len(path_segments) > 0 else ""
    class_name = path_segments[1] if len(path_segments) > 1 else ""
    key = path_segments[-1] if len(path_segments) > 0 else ""

    if len(path_segments) > 3:
        suffix = ".".join(path_segments[2:-1])
    elif len(path_segments) == 3:
        suffix = path_segments[2]
    else:
        suffix = ""

    val_str = "" if value is None else str(value)
    adj_val = get_bucket(value, full_path)
    arr_key = "|".join(array_keys) if array_keys else ""

    rows.append({
        "APP_ID": app_id,
        "SOURCE": source,
        "PREFIX": prefix,
        "CLASS": class_name,
        "SUFFIX": suffix,
        "ARRAY_KEY": arr_key,
        "KEY": key,
        "VALUE": val_str,
        "ADJUSTED_VALUE": adj_val
    })

def flatten_json_recursive(node, path_segments, array_keys, rows, app_id, source):
    current_path = ".".join(path_segments)
    if current_path in EXCLUDE_PATHS:
        return

    if isinstance(node, dict):
        for k, v in node.items():
            flatten_json_recursive(v, path_segments + [k], array_keys, rows, app_id, source)

    elif isinstance(node, list):
        for idx, item in enumerate(node):
            if current_path == "decisionResult.scoring.value":
                elem_key = str(idx)
            elif current_path in ARRAY_KEY_RULES:
                elem_key = ARRAY_KEY_RULES[current_path](item)
            elif isinstance(item, (str, int, float)):
                elem_key = str(item)
            else:
                elem_key = str(idx)

            new_arr_keys = array_keys + [elem_key]

            if isinstance(item, dict):
                for k, v in item.items():
                    flatten_json_recursive(v, path_segments + [k], new_arr_keys, rows, app_id, source)
            else:
                _emit_row(rows, app_id, source, path_segments, new_arr_keys, str(item))

    else:
        _emit_row(rows, app_id, source, path_segments, array_keys, node)

def normalize_file(file_path, source="BEFORE"):
    app_id = os.path.splitext(os.path.basename(file_path))[0]
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    rows = []
    flatten_json_recursive(data, [], [], rows, app_id, source)
    return pd.DataFrame(rows)
