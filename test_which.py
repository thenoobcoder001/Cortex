import shutil
import os

def test_which():
    print(f"PATH: {os.environ.get('PATH')}")
    print(f"gemini: {shutil.which('gemini')}")
    print(f"gemini.cmd: {shutil.which('gemini.cmd')}")
    print(f"gemini.ps1: {shutil.which('gemini.ps1')}")

if __name__ == "__main__":
    test_which()
