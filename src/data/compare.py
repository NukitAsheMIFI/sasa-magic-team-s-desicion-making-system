import os
import pandas as pd
from normalize import normalize_file

def compare_dataframes(df_before, df_after):
    """
    Сопоставляет строки срезов BEFORE и AFTER по ключу (APP_ID, PATH, ARRAY_KEY)
    и размечает 4 типа изменений (CHANGE_TYPE) и флаг различия (DIFF_FLAG).
    """
    if isinstance(df_before, list):
        df_before = pd.DataFrame(df_before)
    if isinstance(df_after, list):
        df_after = pd.DataFrame(df_after)

    # Используем чистый PATH прямо из нормализатора для точного сопоставления
    join_keys = ["APP_ID", "PATH", "PREFIX", "CLASS", "SUFFIX", "ARRAY_KEY", "KEY"]

    merged = pd.merge(
        df_before,
        df_after,
        on=join_keys,
        how="outer",
        suffixes=("_BEFORE", "_AFTER")
    )

    merged["VALUE_BEFORE"] = merged["VALUE_BEFORE"].fillna("")
    merged["VALUE_AFTER"] = merged["VALUE_AFTER"].fillna("")
    merged["ADJUSTED_BEFORE"] = merged["ADJUSTED_VALUE_BEFORE"].fillna("")
    merged["ADJUSTED_AFTER"] = merged["ADJUSTED_VALUE_AFTER"].fillna("")

    # Классификация 4 типов изменений
    change_types = []
    diff_flags = []

    for _, row in merged.iterrows():
        val_b = row["VALUE_BEFORE"]
        val_a = row["VALUE_AFTER"]
        has_b = row["SOURCE_BEFORE"] == "BEFORE"
        has_a = row["SOURCE_AFTER"] == "AFTER"

        if has_b and has_a:
            if val_b == val_a:
                change_types.append("SAME")
                diff_flags.append(0)
            else:
                change_types.append("VALUE_CHANGED")
                diff_flags.append(1)
        elif not has_b and has_a:
            change_types.append("ATTRIBUTE_NEW")
            diff_flags.append(1)
        elif has_b and not has_a:
            change_types.append("ATTRIBUTE_LOST")
            diff_flags.append(1)

    merged["CHANGE_TYPE"] = change_types
    merged["DIFF_FLAG"] = diff_flags

    target_columns = [
        "APP_ID", "PREFIX", "CLASS", "SUFFIX", "ARRAY_KEY", "KEY", "PATH",
        "VALUE_BEFORE", "VALUE_AFTER", "ADJUSTED_BEFORE", "ADJUSTED_AFTER",
        "DIFF_FLAG", "CHANGE_TYPE"
    ]
    return merged[target_columns]