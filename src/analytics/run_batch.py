import os
import glob
import pandas as pd
from normalize import normalize_file
from compare import compare_dataframes

def process_all_applications(results_dir):
    # Указываем пути к папкам со срезами
    before_dir = os.path.join(results_dir, "BEFORE_MASTER")
    after_dir = os.path.join(results_dir, "AFTER_BETA")

    # Ищем все json-файлы в папке BEFORE_MASTER
    before_files = glob.glob(os.path.join(before_dir, "*.json"))
    print(f"Всего найдено файлов в BEFORE: {len(before_files)}")

    comparison_frames = []
    segment_records = []

    for idx, p_b in enumerate(before_files):
        fname = os.path.basename(p_b)
        app_id = os.path.splitext(fname)[0] # Имя файла без .json это и есть APP_ID
        
        # Формируем путь к такому же файлу в AFTER_BETA
        p_a = os.path.join(after_dir, fname)

        # Если файла в AFTER нет, пропускаем (хотя по условию они должны быть)
        if not os.path.exists(p_a):
            print(f"Пропуск: нет файла {fname} в AFTER")
            continue

        # 1. Нормализуем обе версии
        df_b = normalize_file(p_b, source="BEFORE")
        df_a = normalize_file(p_a, source="AFTER")

        # ВАЖНО: Принудительно ставим APP_ID, так как normalize берет его из имени файла
        df_b["APP_ID"] = app_id
        df_a["APP_ID"] = app_id

        # 2. Сравниваем
        diff = compare_dataframes(df_b, df_a)
        comparison_frames.append(diff)

        # 3. Собираем слой разрезов для заявки (решения, продукты)
        # Ищем значение поля 'decision' в обоих срезах
        dec_b_series = df_b[df_b["KEY"] == "decision"]["VALUE"].values
        dec_a_series = df_a[df_a["KEY"] == "decision"]["VALUE"].values
        dec_b = dec_b_series[0] if len(dec_b_series) > 0 else ""
        dec_a = dec_a_series[0] if len(dec_a_series) > 0 else ""

        # Продукты (собираем все product_id из available_offers в AFTER)
                # Берем PATH из уже сравненной таблицы diff
        products = ";".join(diff[diff["PATH"].str.contains("available_offers.product_id", na=False)]["VALUE_AFTER"].dropna().unique())

        segment_records.append({
            "APP_ID": app_id,
            "DECISION_BEFORE": dec_b,
            "DECISION_AFTER": dec_a,
            "DECISION_CHANGED": 1 if dec_b != dec_a else 0,
            "PRODUCTS": products
        })

        # Выводим прогресс каждые 250 файлов (чтобы не засорять консоль)
        if (idx + 1) % 250 == 0 or (idx + 1) == len(before_files):
            print(f"Обработано: {idx + 1} / {len(before_files)}")

    # Склеиваем все куски в один большой DataFrame
    full_mart = pd.concat(comparison_frames, ignore_index=True)
    df_segments = pd.DataFrame(segment_records)

    return full_mart, df_segments

if __name__ == "__main__":
    current_dir = os.path.dirname(os.path.abspath(__file__))
    
    # Путь к твоей папке с результатами (проверь, чтобы путь совпадал с реальным)
    results_path = r"C:\Users\admin\git\sasa-magic-team-s-desicion-making-system\src\data\RUN-20260827-0001\RESULTS"

    mart_df, seg_df = process_all_applications(results_path)

    # Сохраняем результат, чтобы не пересчитывать каждый раз
    mart_df.to_parquet("mart_comparison.parquet")
    seg_df.to_parquet("segments.parquet")

    print("\nИТОГИ ПРОГОНА:")
    print(f"1. Строк в витрине: {len(mart_df)}")
    print(f"2. Заявок с различиями: {mart_df[mart_df['DIFF_FLAG'] == 1]['APP_ID'].nunique()}")
    print(f"3. Заявок со сменой решения: {seg_df['DECISION_CHANGED'].sum()}")

    # Считаем баланс одобрений (+ / -)
    new_app = len(seg_df[(seg_df['DECISION_BEFORE'] == 'REJECT') & (seg_df['DECISION_AFTER'] == 'APPROVE')])
    lost_app = len(seg_df[(seg_df['DECISION_BEFORE'] == 'APPROVE') & (seg_df['DECISION_AFTER'] == 'REJECT')])
    print(f"4. Баланс одобрений: +{new_app} новых / -{lost_app} потерь (Дельта: {new_app - lost_app:+d})")