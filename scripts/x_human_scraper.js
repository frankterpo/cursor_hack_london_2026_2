/**
 * X.com Deep Scraper Interceptor
 * 
 * Instructions:
 * 1. Copy this entire script.
 * 2. Open X.com/ericzakariasson in your browser.
 * 3. Right-click > Inspect > Console.
 * 4. Paste and press Enter.
 * 5. Scroll down the feed. The console will log "BATCH CAPTURED" as you go.
 */

(function () {
    window.__scrapedTweets = new Map();
    console.log("%c >>> X DEEP SCRAPER INITIALIZED <<< ", "background: #1d9bf0; color: white; font-weight: bold; padding: 4px;");
    console.log("Instructions: Scroll down. When done, run: %cexportScrapedData()", "color: #1d9bf0; font-weight: bold;");

    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = args[0] instanceof Request ? args[0].url : args[0];

        if (url.includes('UserTweets') || url.includes('UserByScreenName')) {
            const clone = response.clone();
            clone.json().then(data => {
                processGraphQLBatch(data);
            }).catch(() => { });
        }
        return response;
    };

    function processGraphQLBatch(data) {
        let count = 0;

        // Recursive search for tweet objects
        function findTweets(obj) {
            if (!obj || typeof obj !== 'object') return;

            if (obj.legacy && obj.rest_id) {
                const tweet = obj.legacy;
                const id = obj.rest_id;

                if (!window.__scrapedTweets.has(id)) {
                    const media = [];
                    if (obj.legacy.extended_entities && obj.legacy.extended_entities.media) {
                        obj.legacy.extended_entities.media.forEach(m => {
                            if (m.type === 'video' || m.type === 'animated_gif') {
                                // Find highest bitrate mp4
                                const variants = m.video_info.variants
                                    .filter(v => v.content_type === 'video/mp4' && v.bitrate)
                                    .sort((a, b) => b.bitrate - a.bitrate);
                                if (variants.length > 0) {
                                    media.push({ type: m.type, url: variants[0].url, thumbnail: m.media_url_https });
                                } else if (m.video_info.variants.length > 0) {
                                    media.push({ type: m.type, url: m.video_info.variants[0].url, thumbnail: m.media_url_https });
                                }
                            } else {
                                media.push({ type: 'photo', url: m.media_url_https });
                            }
                        });
                    }

                    window.__scrapedTweets.set(id, {
                        status_id: id,
                        url: `https://x.com/i/status/${id}`,
                        text: tweet.full_text,
                        created_at: tweet.created_at,
                        metrics: {
                            likes: tweet.favorite_count,
                            retweets: tweet.retweet_count,
                            replies: tweet.reply_count,
                            quotes: tweet.quote_count,
                            views: obj.views?.count || "N/A"
                        },
                        media: media,
                        is_thread: tweet.full_text.match(/\d+\/\d+/) ? true : false
                    });
                    count++;
                }
            }

            for (const key in obj) {
                if (obj.hasOwnProperty(key)) findTweets(obj[key]);
            }
        }

        findTweets(data);
        if (count > 0) {
            console.log(`%c BATCH CAPTURED: +${count} unique posts (Total: ${window.__scrapedTweets.size}) `, "background: #22c55e; color: white;");
        }
    }

    window.exportScrapedData = function () {
        const data = Array.from(window.__scrapedTweets.values());
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `eric_tweets_raw_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        console.log(`%c EXPORTED ${data.length} POSTS `, "background: #1d9bf0; color: white; font-weight: bold;");
    };
})();
