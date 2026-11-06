import subprocess
import json
import os

def execute_python_script(script_path: str, input_args: dict) -> dict:
    """
    Запускает пользовательский .py скрипт.
    input_args передаются как JSON в переменную окружения или через stdin.
    """
    if not os.path.exists(script_path):
        raise FileNotFoundError(f"Script not found: {script_path}")
    
    try:
        result = subprocess.run(
            ["python", script_path],
            input=json.dumps(input_args),
            text=True,
            capture_output=True,
            timeout=300 # 5 минут таймаут
        )
        
        if result.returncode != 0:
            return {"success": False, "error": result.stderr}
            
        # Предполагаем, что скрипт печатает в stdout JSON с результатом
        return {"success": True, "data": json.loads(result.stdout)}
        
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Script execution timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}