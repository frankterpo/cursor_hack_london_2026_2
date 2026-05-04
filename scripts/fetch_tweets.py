import os
import requests
import json
from pathlib import Path

# Manual fallback if dotenv is not working for some reason
BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAAJQOswEAAAAAwp%2FHzNqKdkHT6TT7%2FZkbK%2FIgMRE%3DjQA3T5YMI5ygUXKItYg4R8cilA8QtnAfBMqiCvMIne3TwUtmAD"

def create_headers(bearer_token):
    headers = {"Authorization": "Bearer {}".format(bearer_token)}
    return headers

def connect_to_endpoint(url, headers, params):
    response = requests.request("GET", url, headers=headers, params=params)
    print(f"Status Code: {response.status_code}")
    if response.status_code != 200:
        raise Exception(f"Request returned an error: {response.status_code} {response.text}")
    return response.json()

def get_user_id(username):
    url = f"https://api.twitter.com/2/users/by/username/{username}"
    headers = create_headers(BEARER_TOKEN)
    json_response = connect_to_endpoint(url, headers, None)
    return json_response['data']['id']

def get_user_tweets(user_id, max_results=100):
    url = f"https://api.twitter.com/2/users/{user_id}/tweets"
    params = {
        "max_results": max_results,
        "tweet.fields": "created_at,author_id,conversation_id,public_metrics,referenced_tweets,text",
        "exclude": "retweets" # Include replies this time
    }
    headers = create_headers(BEARER_TOKEN)
    return connect_to_endpoint(url, headers, params)

def main():
    username = "ericzakariasson"
    try:
        user_id = get_user_id(username)
        print(f"User ID for {username}: {user_id}")
        
        # Fetch tweets including replies
        tweets = get_user_tweets(user_id, max_results=100)
        data = tweets.get('data', [])
        print(f"Fetched {len(data)} tweets.")
        
        # Group by conversation_id
        threads_map = {}
        for tweet in sorted(data, key=lambda x: x.get('created_at', '')):
            conv_id = tweet.get('conversation_id')
            if not conv_id:
                conv_id = tweet['id']
                
            if conv_id not in threads_map:
                threads_map[conv_id] = {
                    "id": conv_id,
                    "created_at": tweet.get('created_at'),
                    "text": tweet['text'],
                    "metrics": tweet.get('public_metrics', {}),
                    "thread": []
                }
            else:
                threads_map[conv_id]["thread"].append(tweet['text'])
                
        # Re-sort to newest first based on first tweet in thread
        all_posts = sorted(list(threads_map.values()), key=lambda x: x.get('created_at', ''), reverse=True)
            
        # Write out
        out_path = Path("artifacts/eric_tweets.json")
        out_path.parent.mkdir(exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(all_posts, f, indent=2)
            
        print(f"Successfully saved {len(all_posts)} thread/posts to {out_path}")
        
    except Exception as e:
        print(f"An error occurred: {e}")

if __name__ == "__main__":
    main()
