# -*- coding: utf-8 -*-
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
}