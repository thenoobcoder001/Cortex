import sys
import json
import os
import urllib.request
from pathlib import Path

# Minimal GeminiProvider test using urllib (no external dependencies)
def test_gemini_rest():
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        print("\nREST API Error: GEMINI_API_KEY is not set")
        return False
    model = "gemini-2.0-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    
    body = {
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "generation_config": {"temperature": 0.2}
    }
    
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    
    print(f"Testing Gemini REST API with model: {model}...")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            text = result["candidates"][0]["content"]["parts"][0]["text"]
            print("\nResponse from Gemini REST:")
            print(text.strip())
            return True
    except Exception as e:
        print(f"\nREST API Error: {e}")
        return False

if __name__ == "__main__":
    ok = test_gemini_rest()
    raise SystemExit(0 if ok else 1)
