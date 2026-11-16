"""Expose login status only. CLI output may contain a key: never forward it."""
import json
import subprocess


def account_status(code, output):
    text = output.lower()
    if code == 0 and "logged in using chatgpt" in text:
        return {"loggedIn": True, "method": "ChatGPT"}
    if code == 0 and "logged in using" in text and "api key" in text:
        return {"loggedIn": True, "method": "API key"}
    if "not logged in" in text:
        return {"loggedIn": False}
    return {"error": "Could not determine Codex login status. Try codex login status in a terminal."}


def read_account():
    try:
        result = subprocess.run(["codex", "login", "status"], capture_output=True, text=True, timeout=8)
        return account_status(result.returncode, result.stdout + "\n" + result.stderr)
    except FileNotFoundError:
        return {"missing": True, "error": "Codex is not installed or is not on Herdr's PATH."}
    except subprocess.TimeoutExpired:
        return {"error": "Codex login status timed out. Try again."}
    except OSError:
        return {"error": "Could not run codex login status. Try again."}


if __name__ == "__main__":
    print(json.dumps(read_account()))
