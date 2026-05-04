import subprocess
import time
import json
from pathlib import Path

def run_applescript(script):
    result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
    return result.stdout.strip()

print("Opening Google Chrome to Eric's profile...")
run_applescript('''
tell application "Google Chrome"
    activate
    open location "https://x.com/ericzakariasson"
end tell
''')

print("Waiting for page to load (8 seconds)...")
time.sleep(8)

all_tweets = set()

for i in range(20):
    print(f"Scrolling ({i+1}/20)...")
    run_applescript('''
    tell application "Google Chrome"
        set activeTab to active tab of front window
        execute activeTab javascript "window.scrollBy(0, document.body.scrollHeight);"
    end tell
    ''')
    time.sleep(3)
    
    # Use single quotes for the querySelector attributes to easily embed in AppleScript's double quotes
    js = '''var txts = []; var nodes = document.querySelectorAll("[data-testid='tweetText']"); for(var i=0; i<nodes.length; i++) { txts.push(nodes[i].innerText); } JSON.stringify(txts);'''
    
    applescript = f'''
    tell application "Google Chrome"
        set activeTab to active tab of front window
        execute activeTab javascript "{js}"
    end tell
    '''
    
    res = run_applescript(applescript)
    if res:
        try:
            # Safely log output and load it. AppleScript might return quoted JSON
            data = json.loads(res)
            for d in data:
                all_tweets.add(d)
        except Exception as e:
            pass

out_path = Path("artifacts/eric_tweets_frankterpo.json")
out_path.parent.mkdir(exist_ok=True)
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(list(all_tweets), f, indent=2, ensure_ascii=False)

print(f"Done! Scraped {len(all_tweets)} unique posts!")
