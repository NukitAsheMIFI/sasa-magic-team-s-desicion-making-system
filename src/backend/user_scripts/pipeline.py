import json
import sys
import os
import pandas as pd

# --- МАГИЯ ПУТЕЙ ---
# Мы находимся в src/backend/user_scripts. Нам нужно попасть в src/data.
current_dir = os.path.dirname(os.path.abspath(__file__))
data_dir = os.path.abspath(os.path.join(current_dir, "../../data"))
sys.path.append(data_dir)

# Теперь импорты аналитика сработают
from normalize import normalize_file
from compare import compare_dataframes

def main():
    import os
import pathlib
# ... (остальные импорты)

def main():
    input_data = json.loads(sys.stdin.read())
    
    # Убираем возможные невидимые пробелы и переносы строк
    before_dir = input_data["before_dir"].strip()
    after_dir = input_data["after_dir"].strip()
    out_file = input_data["out_file"].strip()

    # --- ОТЛАДКА ---
    print(f"Путь, который проверяем: {repr(before_dir)}")
    
    b_path = pathlib.Path(before_dir)
    print(f"Папка существует? {b_path.exists()}")
    print(f"Это папка? {b_path.is_dir()}")
    
    parent = b_path.parent
    if parent.exists():
        print(f"Содержимое родительской папки RESULTS: {os.listdir(parent)}")
    else:
        print("Родительской папки RESULTS тоже не существует!")
    # ---------------

    print("Начинаем нормализацию BEFORE...")
    dfs_before = []
    for file in os.listdir(before_dir):
        if file.endswith(".json"):
            dfs_before.append(normalize_file(os.path.join(before_dir, file), "BEFORE"))
    
    if not dfs_before:
        print("Ошибка: файлы BEFORE не найдены по пути " + before_dir)
        sys.exit(1)
        
    df_before = pd.concat(dfs_before, ignore_index=True)

    print("Начинаем нормализацию AFTER...")
    dfs_after = []
    for file in os.listdir(after_dir):
        if file.endswith(".json"):
            dfs_after.append(normalize_file(os.path.join(after_dir, file), "AFTER"))
            
    df_after = pd.concat(dfs_after, ignore_index=True)

    print("Сравниваем данные...")
    df_result = compare_dataframes(df_before, df_after)

    # Сохраняем результат
    df_result.to_csv(out_file, sep=";", index=False, encoding="utf-8-sig")
    print(f"Готово! Сохранено {len(df_result)} строк в {out_file}")
    
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

    verdict_file = os.path.join(out_dir, "verdict.json")
    with open(verdict_file, "w", encoding="utf-8") as f:
        json.dump(verdict_data, f, ensure_ascii=False, indent=2)

    print(f"Бизнес-вердикт сохранен в {verdict_file}")

if __name__ == "__main__":
    main()