import os
import requests
import json
import time

BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAAJQOswEAAAAAwp%2FHzNqKdkHT6TT7%2FZkbK%2FIgMRE%3DjQA3T5YMI5ygUXKItYg4R8cilA8QtnAfBMqiCvMIne3TwUtmAD"

def create_headers(bearer_token):
    headers = {"Authorization": f"Bearer {bearer_token}"}
    return headers

def check_rate_limit():
    user_id = "505835394"
    url = f"https://api.twitter.com/2/users/{user_id}/tweets"
    params = {
        "max_results": 10,
        "tweet.fields": "created_at"
    }
    headers = create_headers(BEARER_TOKEN)
    response = requests.request("GET", url, headers=headers, params=params)
    print(f"Status Code: {response.status_code}")
    for k, v in response.headers.items():
        if 'rate-limit' in k.lower():
            print(f"{k}: {v}")
            from datetime import datetime
            if 'reset' in k.lower():
                print("Resets at:", datetime.fromtimestamp(int(v)).strftime('%Y-%m-%d %H:%M:%S'))
                
check_rate_limit()
