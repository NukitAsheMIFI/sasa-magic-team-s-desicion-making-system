import json
import sys
import os
import pathlib
import pandas as pd

# Подключаем папку src/data для импорта нормализатора и сравнения
current_dir = os.path.dirname(os.path.abspath(__file__))
data_dir = os.path.abspath(os.path.join(current_dir, "../../data"))
sys.path.append(data_dir)

from normalize import normalize_file
from compare import compare_dataframes

def extract_app_segment(app_id, df_b, df_a):
    """Извлекает одну сводную строку разрезов по заявке для проверки AR и моделей."""
    def get_val(df, key_name):
        sub = df[df["KEY"] == key_name]
        return str(sub["VALUE"].iloc[0]) if not sub.empty and pd.notna(sub["VALUE"].iloc[0]) else ""

    dec_b = get_val(df_b, "decision")
    dec_a = get_val(df_a, "decision")

    # Извлекаем уникальные продукты (product_id) через точку с запятой
    prod_b = df_b[df_b["KEY"] == "product_id"]["VALUE"].dropna().unique().tolist()
    prod_a = df_a[df_a["KEY"] == "product_id"]["VALUE"].dropna().unique().tolist()
    all_prods = sorted(list(set(map(str, prod_b + prod_a))))
    products_str = ";".join(all_prods)

    # 1. Модели скоринга: ищем модель именно в целевом блоке pd
    def get_pd_model(df):
        sub = df[(df["KEY"] == "modelName") & (df["CLASS"] == "pd")]
        if sub.empty:
            sub = df[df["KEY"] == "modelName"]
        return str(sub["VALUE"].iloc[0]) if not sub.empty and pd.notna(sub["VALUE"].iloc[0]) else ""

    # 2. Порог отсечки: ищем cutOff / cutoff без учета регистра
    def get_cutoff(df):
        sub = df[df["KEY"].str.lower() == "cutoff"]
        return str(sub["VALUE"].iloc[0]) if not sub.empty and pd.notna(sub["VALUE"].iloc[0]) else ""

    model_b = get_pd_model(df_b)
    model_a = get_pd_model(df_a)
    cutoff_b = get_cutoff(df_b)
    cutoff_a = get_cutoff(df_a)

    return {
        "APP_ID": str(app_id),
        "DECISION_BEFORE": dec_b,
        "DECISION_AFTER": dec_a,
        "DECISION_CHANGED": 1 if dec_b != dec_a else 0,
        "PRODUCTS": products_str,
        "PD_MODEL_BEFORE": model_b,
        "PD_MODEL_AFTER": model_a,
        "CUTOFF_BEFORE": cutoff_b,
        "CUTOFF_AFTER": cutoff_a
    }

def main():
    input_data = json.loads(sys.stdin.read())
    before_dir = input_data["before_dir"].strip()
    after_dir = input_data["after_dir"].strip()
    out_file = input_data["out_file"].strip()

    # Путь для сохранения segments.csv рядом с основным результатом
    out_dir = os.path.dirname(out_file)
    segments_file = out_file.replace(".csv", "_segments.csv")

    files = sorted([f for f in os.listdir(before_dir) if f.endswith(".json")])
    if not files:
        print(f"Ошибка: файлы BEFORE не найдены в {before_dir}")
        sys.exit(1)

    print(f"Обработка {len(files)} заявок...")
    all_diffs = []
    all_segments = []

    for fname in files:
        app_id = os.path.splitext(fname)[0]
        p_b = os.path.join(before_dir, fname)
        p_a = os.path.join(after_dir, fname)

        if not os.path.exists(p_a):
            continue

        df_b = normalize_file(p_b, source="BEFORE", app_id=app_id)
        df_a = normalize_file(p_a, source="AFTER", app_id=app_id)

        # 1. Построчное сравнение заявки
        diff = compare_dataframes(df_b, df_a)
        all_diffs.append(diff)

        # 2. Формирование строки для слоя разрезов
        seg = extract_app_segment(app_id, df_b, df_a)
        all_segments.append(seg)

    print("Сборка и сохранение витрины сравнения...")
    df_result = pd.concat(all_diffs, ignore_index=True)
    df_result.to_csv(out_file, sep=";", index=False, encoding="utf-8-sig")
    print(f"Сохранено строк витрины: {len(df_result)} в {out_file}")

    print("Сборка и сохранение слоя разрезов (segments.csv)...")
    df_segments = pd.DataFrame(all_segments)
    df_segments.to_csv(segments_file, sep=";", index=False, encoding="utf-8-sig")
    print(f"Сохранено заявок в segments.csv: {len(df_segments)}")
    # --- РАСЧЕТ БИЗНЕС-ВЕРДИКТА ---
    total = len(df_segments)
    app_b = int((df_segments["DECISION_BEFORE"] == "APPROVE").sum())
    app_a = int((df_segments["DECISION_AFTER"] == "APPROVE").sum())
    new_app = int(len(df_segments[(df_segments["DECISION_BEFORE"] != "APPROVE") & (df_segments["DECISION_AFTER"] == "APPROVE")]))
    lost_app = int(len(df_segments[(df_segments["DECISION_BEFORE"] == "APPROVE") & (df_segments["DECISION_AFTER"] != "APPROVE")]))
    net_impact = new_app - lost_app

    verdict_data = {
        "total_apps": total,
        "ar_before": round(app_b / total * 100, 2) if total else 0.0,
        "ar_after": round(app_a / total * 100, 2) if total else 0.0,
        "new_approved": new_app,
        "lost_approved": lost_app,
        "net_impact": net_impact,
        "summary": "Ужесточение стратегии" if net_impact < 0 else "Экспансия портфеля"
    }

    verdict_file = out_file.replace(".csv", "_verdict.json")
    with open(verdict_file, "w", encoding="utf-8") as f:
        json.dump(verdict_data, f, ensure_ascii=False, indent=2)

    print(f"Бизнес-вердикт сохранен в {verdict_file}")

if __name__ == "__main__":
    main()