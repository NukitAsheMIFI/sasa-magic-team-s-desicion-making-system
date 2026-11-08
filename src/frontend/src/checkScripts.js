// Исходники 5 проверок (копия из репозитория бэкенда). Лучше отдавать с бэка через code_ref.
export const REPO_PYTHON_SCRIPTS = {
  ar_drop_by_product: `# -*- coding: utf-8 -*-
"""Approval Rate по продукту: FAIL, если относительное падение больше порога."""

DEFAULTS = {"max_drop_rel": 0.10, "low_confidence_cnt": 5, "app_ids_limit": 20}


def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    by_product = {}
    for s in mart.segments():
        for product in (s.get("PRODUCTS") or "").split(";"):
            if not product:
                continue
            d = by_product.setdefault(product, {"total": 0, "ap_b": 0, "ap_a": 0, "lost": []})
            d["total"] += 1
            if s.get("DECISION_BEFORE") == "APPROVE":
                d["ap_b"] += 1
            if s.get("DECISION_AFTER") == "APPROVE":
                d["ap_a"] += 1
            if s.get("DECISION_BEFORE") == "APPROVE" and s.get("DECISION_AFTER") != "APPROVE":
                d["lost"].append(s["APP_ID"])

    rows = []
    for product, d in sorted(by_product.items()):
        ar_b = d["ap_b"] / d["total"] if d["total"] else 0.0
        ar_a = d["ap_a"] / d["total"] if d["total"] else 0.0
        drop_rel = (ar_b - ar_a) / ar_b if ar_b else 0.0
        failed = drop_rel > p["max_drop_rel"]
        rows.append({
            "LABEL": CHECK["label"],
            "SOURCE": "AFTER",
            "ARGUMENT": product,
            "CNT": len(d["lost"]),
            "TOTAL": d["total"],
            "METRIC": round(drop_rel, 4),
            "APP_IDS": sorted(d["lost"])[:p["app_ids_limit"]],
            "RESULT": "FAIL" if failed else "PASS",
            "CONFIDENCE": "LOW" if len(d["lost"]) < p["low_confidence_cnt"] else "HIGH",
        })
    return rows


CHECK = {"id": "ar_drop_by_product",
         "label": "Approval Rate по продукту упал",
         "params": DEFAULTS,
         "entrypoint": run}`,
  attribute_new_loss: `# -*- coding: utf-8 -*-
"""Изменился состав атрибутов ответа: появились новые или пропали существующие.

Считается по PATH, а не по конкретной заявке: важно, что атрибут появился
или исчез как таковой, и у какой доли заявок это произошло.
"""

DEFAULTS = {"min_share": 0.001, "low_confidence_cnt": 5, "app_ids_limit": 20}


def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()
    agg = {}
    for change in ("ATTRIBUTE_NEW", "ATTRIBUTE_LOST"):
        for r in mart.rows(change_type=change):
            agg.setdefault((change, r["PATH"]), set()).add(r["APP_ID"])

    rows = []
    for (change, path), apps in sorted(agg.items()):
        share = len(apps) / total if total else 0.0
        if share < p["min_share"]:
            continue
        rows.append({
            "LABEL": CHECK["label"],
            "SOURCE": "AFTER" if change == "ATTRIBUTE_NEW" else "BEFORE",
            "ARGUMENT": path,
            "CNT": len(apps),
            "TOTAL": total,
            "METRIC": round(share, 4),
            "APP_IDS": sorted(apps)[:p["app_ids_limit"]],
            "RESULT": "FAIL",
            "CONFIDENCE": "LOW" if len(apps) < p["low_confidence_cnt"] else "HIGH",
        })
    if not rows:
        rows.append({"LABEL": CHECK["label"], "SOURCE": "AFTER", "ARGUMENT": "",
                     "CNT": 0, "TOTAL": total, "METRIC": 0.0, "APP_IDS": [],
                     "RESULT": "PASS", "CONFIDENCE": "HIGH"})
    return rows


CHECK = {"id": "attribute_new_loss",
         "label": "Изменился состав атрибутов",
         "params": DEFAULTS,
         "entrypoint": run}`,
  external_score_drift: `# -*- coding: utf-8 -*-
"""Различие вызвано входными данными, а не стратегией.

Если внешний источник вернул другой скор, решение может измениться
без всякого изменения стратегии. Для аналитика это ложная тревога,
и такие заявки надо отделять от настоящих эффектов изменения.

Дополнительно сверяет, что предиктор модели совпадает со значением,
пришедшим от источника: расхождение означает, что модель считалась
не на тех данных.
"""

SCORE_PATH = "characteristics.score_okb"
FEATURE_PATH = "decisionResult.scoring.features.score_okb"
DEFAULTS = {"low_confidence_cnt": 5, "app_ids_limit": 20}


def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()

    drifted = {r["APP_ID"] for r in mart.rows(path=SCORE_PATH, diff_flag=1)}
    decision_changed = {s["APP_ID"] for s in mart.segments() if s.get("DECISION_CHANGED")}
    false_alarm = drifted & decision_changed

    mismatch = set()
    feat = {}
    for r in mart.rows(path=FEATURE_PATH):
        feat[r["APP_ID"]] = (r.get("VALUE_BEFORE"), r.get("VALUE_AFTER"))
    for r in mart.rows(path=SCORE_PATH):
        f = feat.get(r["APP_ID"])
        if f and f != (r.get("VALUE_BEFORE"), r.get("VALUE_AFTER")):
            mismatch.add(r["APP_ID"])

    rows = [{
        "LABEL": CHECK["label"],
        "SOURCE": "AFTER",
        "ARGUMENT": SCORE_PATH,
        "CNT": len(false_alarm),
        "TOTAL": total,
        "METRIC": round(len(false_alarm) / total, 4) if total else 0.0,
        "APP_IDS": sorted(false_alarm)[:p["app_ids_limit"]],
        "RESULT": "FAIL" if false_alarm else "PASS",
        "CONFIDENCE": "LOW" if 0 < len(false_alarm) < p["low_confidence_cnt"] else "HIGH",
    }, {
        "LABEL": CHECK["label"],
        "SOURCE": "AFTER",
        "ARGUMENT": "предиктор != источник",
        "CNT": len(mismatch),
        "TOTAL": total,
        "METRIC": round(len(mismatch) / total, 4) if total else 0.0,
        "APP_IDS": sorted(mismatch)[:p["app_ids_limit"]],
        "RESULT": "FAIL" if mismatch else "PASS",
        "CONFIDENCE": "LOW" if 0 < len(mismatch) < p["low_confidence_cnt"] else "HIGH",
    }]
    return rows


CHECK = {"id": "external_score_drift",
         "label": "Различие вызвано входными данными",
         "params": DEFAULTS,
         "entrypoint": run}`,
  stop_factor_disappeared: `# -*- coding: utf-8 -*-
"""Стоп-фактор перестал работать: правило пропало из ответа либо hit true -> false.

Разделяет два случая, потому что в отчёте они читаются по-разному:
пропавший атрибут — это изменение набора правил, смена hit — изменение поведения.
"""

RULE_HIT_PATH = "decisionResult.product_trials.rules.hit"
DEFAULTS = {"low_confidence_cnt": 5, "app_ids_limit": 20}


def _rule_name(array_key):
    # ARRAY_KEY здесь имеет вид "<product_id>|<rule_name>"
    parts = (array_key or "").split("|")
    return parts[-1] if parts else ""


def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    lost, turned_off = {}, {}

    for r in mart.rows(path=RULE_HIT_PATH, change_type="ATTRIBUTE_LOST"):
        if r.get("VALUE_BEFORE") == "true":
            lost.setdefault(_rule_name(r["ARRAY_KEY"]), set()).add(r["APP_ID"])

    for r in mart.rows(path=RULE_HIT_PATH, change_type="VALUE_CHANGED"):
        if r.get("VALUE_BEFORE") == "true" and r.get("VALUE_AFTER") in ("false", "NULL"):
            turned_off.setdefault(_rule_name(r["ARRAY_KEY"]), set()).add(r["APP_ID"])

    total = mart.total_apps()
    rows = []
    for title, bucket in (("правило удалено из стратегии", lost),
                          ("правило перестало срабатывать", turned_off)):
        for rule, apps in sorted(bucket.items()):
            rows.append({
                "LABEL": CHECK["label"],
                "SOURCE": "AFTER",
                "ARGUMENT": rule,
                "CNT": len(apps),
                "TOTAL": total,
                "METRIC": round(len(apps) / total, 4) if total else 0.0,
                "APP_IDS": sorted(apps)[:p["app_ids_limit"]],
                "RESULT": "FAIL",
                "CONFIDENCE": "LOW" if len(apps) < p["low_confidence_cnt"] else "HIGH",
            })
    if not rows:
        rows.append({"LABEL": CHECK["label"], "SOURCE": "AFTER", "ARGUMENT": "",
                     "CNT": 0, "TOTAL": total, "METRIC": 0.0, "APP_IDS": [],
                     "RESULT": "PASS", "CONFIDENCE": "HIGH"})
    return rows


CHECK = {"id": "stop_factor_disappeared",
         "label": "Стоп-фактор перестал работать",
         "params": DEFAULTS,
         "entrypoint": run}`,
  target_model_changed: `# -*- coding: utf-8 -*-
"""Сменилась целевая модель, по которой принимается решение по продукту.

Целевую модель выбирает сама стратегия, поэтому её смена — не техническая
деталь, а изменение логики принятия решения. Отдельно выделяются заявки,
где вместе с моделью изменился и применённый порог.
"""

DEFAULTS = {"low_confidence_cnt": 5, "app_ids_limit": 20}


def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()
    pairs, with_cutoff = {}, {}
    for s in mart.segments():
        mb, ma = s.get("PD_MODEL_BEFORE"), s.get("PD_MODEL_AFTER")
        if mb == ma:
            continue
        key = f"{mb} -> {ma}"
        pairs.setdefault(key, set()).add(s["APP_ID"])
        if s.get("CUTOFF_BEFORE") != s.get("CUTOFF_AFTER"):
            with_cutoff.setdefault(key, set()).add(s["APP_ID"])

    rows = []
    for key, apps in sorted(pairs.items()):
        cut = len(with_cutoff.get(key, ()))
        rows.append({
            "LABEL": CHECK["label"],
            "SOURCE": "AFTER",
            "ARGUMENT": key,
            "CNT": len(apps),
            "TOTAL": total,
            "METRIC": round(len(apps) / total, 4) if total else 0.0,
            "APP_IDS": sorted(apps)[:p["app_ids_limit"]],
            "RESULT": "FAIL",
            "CONFIDENCE": "LOW" if len(apps) < p["low_confidence_cnt"] else "HIGH",
        })
    if not rows:
        rows.append({"LABEL": CHECK["label"], "SOURCE": "AFTER", "ARGUMENT": "",
                     "CNT": 0, "TOTAL": total, "METRIC": 0.0, "APP_IDS": [],
                     "RESULT": "PASS", "CONFIDENCE": "HIGH"})
    return rows


CHECK = {"id": "target_model_changed",
         "label": "Сменилась целевая модель решения",
         "params": DEFAULTS,
         "entrypoint": run}`,
  product_rule_impact: `# -*- coding: utf-8 -*-
"""
Влияние новых правил на продукты.
Аналитик хочет знать: для каждого продукта, где сработало новое стоп-правило, 
сколько заявок отсеклось и какой общий лимит мы потеряли.
"""
import json

# Путь до лимитов в ответе СПР (подставьте актуальный, если в вашем датасете он другой)
LIMIT_PATH = "decisionResult.limitResult.limit"
RULES_HIT_PATH = "decisionResult.product_trials.rules.hit"

DEFAULTS = {
    "low_confidence_cnt": 5,   # ниже этого числа срабатываний ставим CONFIDENCE=LOW
    "app_ids_limit": 20,       # максимум ID заявок в строке
}

def run(mart, params=None):
    p = {**DEFAULTS, **(params or {})}
    total = mart.total_apps()
    
    # 1. Находим все заявки, где решение было REJECT, а стало APPROVE (или наоборот)
    # Нам важны те, кто перешел в APPROVE из-за снятия правила, или в REJECT из-за нового.
    approved_apps = set()
    for s in mart.segments():
        if s.get("DECISION_BEFORE") != "APPROVE" and s.get("DECISION_AFTER") == "APPROVE":
            approved_apps.add(s["APP_ID"])
            
    if not approved_apps:
        return [{
            "LABEL": CHECK["label"], "SOURCE": "AFTER", "ARGUMENT": "",
            "CNT": 0, "TOTAL": total, "METRIC": 0.0, "APP_IDS": [],
            "RESULT": "PASS", "CONFIDENCE": "HIGH",
        }]

    # 2. Смотрим, у кого из них сработали правила (hit=true)
    # Проверяем только те, что стали APPROVE
    hits = mart.rows(path=RULES_HIT_PATH, change_type="SAME", value_after="true", app_ids=approved_apps)
    
    # Собираем правило и связанные с ним заявки
    rule_apps = {}
    for h in hits:
        # array_key выглядит как "15210|AGELOW@21", берем само правило
        rule_name = h["ARRAY_KEY"].split("|")[-1] if "|" in h["ARRAY_KEY"] else h["ARRAY_KEY"]
        rule_apps.setdefault(rule_name, set()).add(h["APP_ID"])

    # 3. Считаем лимиты для этих заявок (чтобы понять финансовое влияние)
    # Если лимит не изменился, он будет равен BEFORE (это нормально, мы просто хотим сумму)
    limit_rows = mart.rows(path=LIMIT_PATH, app_ids=approved_apps)
    app_limits = {}
    for r in limit_rows:
        # Берем лимит AFTER (актуальный для новой версии)
        val = r.get("VALUE_AFTER")
        if val is not None:
            try:
                app_limits[r["APP_ID"]] = float(val)
            except (ValueError, TypeError):
                pass

    # 4. Формируем строки отчета
    rows = []
    for rule, apps in sorted(rule_apps.items()):
        # Суммируем потерянные лимиты по этому правилу
        total_limit = sum(app_limits.get(app_id, 0.0) for app_id in apps)
        
        rows.append({
            "LABEL": CHECK["label"] + f" [{rule}]",
            "SOURCE": "AFTER",
            "ARGUMENT": rule,
            "CNT": len(apps),
            "TOTAL": total,
            "METRIC": round(total_limit, 2),   # Метрика: сумма лимитов
            "APP_IDS": sorted(apps)[:p["app_ids_limit"]],
            "RESULT": "PASS",                  # Это не ошибка, а факт для сведения
            "CONFIDENCE": "LOW" if len(apps) < p["low_confidence_cnt"] else "HIGH",
        })
        
    if not rows:
        return [{
            "LABEL": CHECK["label"], "SOURCE": "AFTER", "ARGUMENT": "Нет сработавших правил",
            "CNT": 0, "TOTAL": total, "METRIC": 0.0, "APP_IDS": [],
            "RESULT": "PASS", "CONFIDENCE": "HIGH",
        }]

    return rows


CHECK = {
    "id": "product_rule_impact",
    "label": "Влияние новых правил на одобренные заявки (сумма лимитов)",
    "params": DEFAULTS,
    "entrypoint": run,
}`
};
