import json

def generate_executive_summary(verdict_data: dict, checks_report: list) -> dict:
    """
    Генерирует структурированное резюме для руководства и кредитного комитета.
    """
    total = verdict_data.get("total_apps", 2002)
    ar_before = verdict_data.get("ar_before", 0.0)
    ar_after = verdict_data.get("ar_after", 0.0)
    net_impact = verdict_data.get("net_impact", 0)
    new_app = verdict_data.get("new_approved", 0)
    lost_app = verdict_data.get("lost_approved", 0)

    # 1. Анализ провалившихся проверок (FAIL)
    failed_checks = [c for c in checks_report if c.get("RESULT") == "FAIL"]
    
    triggers = []
    for c in failed_checks:
        label = c.get("LABEL")
        arg = c.get("ARGUMENT")
        cnt = c.get("CNT", 0)
        triggers.append(f"• {label} [{arg}]: затронуто {cnt} заявок")

    triggers_text = "\n".join(triggers) if triggers else "Критических срабатываний автопроверок не зафиксировано."

    # 2. Определение вектора стратегии
    if net_impact < 0:
        vector = "консервативное ужесточение кредитной политики"
        impact_desc = f"снижение совокупного кредитного риска за счёт отсечения {abs(net_impact)} пограничных заявок"
        recommendation = "Рекомендовано к пилотному запуску на 10% входящего трафика с контролем конверсии воронки."
    elif net_impact > 0:
        vector = "экспансию кредитного портфеля"
        impact_desc = f"рост объёма выдач на +{net_impact} договоров при допустимом расширении риск-аппетита"
        recommendation = "Требуется дополнительный стресс-тест винтажной просрочки перед масштабированием."
    else:
        vector = "нейтральную ротацию клиентской базы"
        impact_desc = "сохранение общего объёма портфеля при точечной замене профилей клиентов"
        recommendation = "Согласовано к полномасштабному релизу."

    # 3. Финальный текст
    summary_text = (
        f"По итогам сравнительного анализа {total} исторических заявок новая стратегия демонстрирует {vector}. "
        f"Approval Rate изменился с {ar_before:.2f}% до {ar_after:.2f}% (дельта {ar_after - ar_before:+.2f} п.п.). "
        f"Бизнес-эффект: одобрено {new_app} новых клиентов, отклонено {lost_app} ранее проходивших ({impact_desc}).\n\n"
        f"Ключевые факторы расхождений:\n{triggers_text}\n\n"
        f"Рекомендация комитету: {recommendation}"
    )

    return {
        "status": "success",
        "model": "RiskCopilot-Hybrid-v1",
        "confidence": "HIGH",
        "summary": summary_text,
        "metrics_snapshot": {
            "net_impact": net_impact,
            "ar_delta": round(ar_after - ar_before, 2),
            "failed_checks_count": len(failed_checks)
        }
    }