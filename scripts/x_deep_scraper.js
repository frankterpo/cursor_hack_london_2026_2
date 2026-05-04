/**
 * X (Twitter) Deep Scraper Script
 * To be injected via AppleScript into the active tab.
 * Extracts: Text, Timestamp, Metrics (Reply/RT/Like/View), and Media Assets.
 */
function scrapeTweets() {
    const tweets = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    articles.forEach(article => {
        try {
            const tweetTextNode = article.querySelector('[data-testid="tweetText"]');
            const text = tweetTextNode ? tweetTextNode.innerText : "";

            const timeNode = article.querySelector('time');
            const timestamp = timeNode ? timeNode.getAttribute('datetime') : "";

            // Metrics
            const getMetric = (testId) => {
                const node = article.querySelector(`[data-testid="${testId}"]`);
                return node ? node.innerText : "0";
            };

            const metrics = {
                replies: getMetric('reply'),
                retweets: getMetric('retweet'),
                likes: getMetric('like'),
                views: article.innerText.match(/(\d+\.?\d*[KMB]?)\s*Views/i)?.[1] || "0"
            };

            // Assets (Images/Videos)
            const assets = [];
            const images = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
            images.forEach(img => assets.append(img.src));

            const video = article.querySelector('video');
            if (video) assets.append("Video present (URL hidden)");

            tweets.push({
                text,
                timestamp,
                metrics,
                assets,
                id: article.querySelector('a[href*="/status/"]')?.href.split('/').pop()
            });
        } catch (e) {
            console.error("Error scraping individual tweet", e);
        }
    });

    return JSON.stringify(tweets);
}

scrapeTweets();
