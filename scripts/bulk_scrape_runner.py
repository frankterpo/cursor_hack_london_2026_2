import subprocess
import json
import time
from pathlib import Path

def run_scraper(scroll_count=15):
    with open("scripts/x_deep_scraper.js", "r") as f:
        js_code = f.read()

    # Escape backslashes and double quotes for AppleScript
    escaped_js = js_code.replace('\\', '\\\\').replace('"', '\\"')
    
    all_data = {}
    
    print(f"Starting bulk scrape from active Chrome tab...")
    
    for i in range(scroll_count):
        print(f"Iteration {i+1}/{scroll_count}...")
        
        # 1. Execute JS to get data
        applescript = f'''
        tell application "Google Chrome"
            set activeTab to active tab of front window
            set jsResult to execute activeTab javascript "{escaped_js}"
            return jsResult
        end tell
        '''
        
        result = subprocess.run(['osascript', '-e', applescript], capture_output=True, text=True)
        
        if result.stdout.strip():
            try:
                batch = json.loads(result.stdout.strip())
                for tweet in batch:
                    if tweet['id']:
                        all_data[tweet['id']] = tweet
            except Exception as e:
                print(f"Error parsing JSON: {e}")
        
        # 2. Scroll down
        scroll_script = 'tell application "Google Chrome" to execute active tab of front window javascript "window.scrollBy(0, 1000);"'
        subprocess.run(['osascript', '-e', scroll_script])
        
        time.sleep(2) # Wait for load

    # Save results
    out_path = Path("artifacts/eric_tweets_bulk.json")
    out_path.parent.mkdir(exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(list(all_data.values()), f, indent=2, ensure_ascii=False)
        
    print(f"Scrape complete! Captured {len(all_data)} unique posts.")
    print(f"Data saved to {out_path}")

if __name__ == "__main__":
    run_scraper()
