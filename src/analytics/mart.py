import pandas as pd

class DataMart:
    def __init__(self, df_comparison, df_segments):
        # df_comparison — таблица витрины сравнения (из compare.py)
        # df_segments — слой разрезов по заявкам (DECISION_BEFORE, DECISION_AFTER и т.д.)
        self.df = df_comparison if isinstance(df_comparison, pd.DataFrame) else pd.DataFrame(df_comparison)
        self.seg = df_segments if isinstance(df_segments, pd.DataFrame) else pd.DataFrame(df_segments)

    def total_apps(self):
        """Общее количество заявок в прогоне"""
        return len(self.seg)

    def segments(self):
        """Возвращает список словарей со слоем разрезов по каждой заявке"""
        return self.seg.to_dict(orient="records")

    def _apply_filters(self, **filters):
        filtered = self.df
        if "path" in filters:
            p = filters["path"]
            filtered = filtered[filtered["PATH"].isin(p if isinstance(p, list) else [p])]
        if "path_prefix" in filters:
            prefix = filters["path_prefix"]
            filtered = filtered[filtered["PATH"].str.startswith(prefix, na=False)]
        if "change_type" in filters:
            ct = filters["change_type"]
            filtered = filtered[filtered["CHANGE_TYPE"].isin(ct if isinstance(ct, list) else [ct])]
        if "diff_flag" in filters:
            filtered = filtered[filtered["DIFF_FLAG"] == filters["diff_flag"]]
        if "app_ids" in filters:
            filtered = filtered[filtered["APP_ID"].isin(filters["app_ids"])]
        if "key" in filters:
            filtered = filtered[filtered["KEY"] == filters["key"]]
        if "array_key" in filters:
            filtered = filtered[filtered["ARRAY_KEY"] == filters["array_key"]]
        return filtered

    def rows(self, **filters):
        """Строки витрины сравнения по фильтрам"""
        return self._apply_filters(**filters).to_dict(orient="records")

    def count(self, **filters):
        """Количество строк по фильтрам"""
        return len(self._apply_filters(**filters))

    def app_ids(self, **filters):
        """Уникальные отсортированные APP_ID"""
        return sorted(self._apply_filters(**filters)["APP_ID"].unique().tolist())