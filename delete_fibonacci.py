import os

try:
    os.remove("fibonacci.py")
    print("File deleted successfully")
except FileNotFoundError:
    print("File not found")
