/**
 * X.com "Bulletproof" Scraper Interceptor (V3)
 * 
 * WHY THIS IS BETTER:
 * 1. Patches Fetch + XHR (covers all browser network calls).
 * 2. Deep recursion (finds tweets regardless of nested GraphQL structure).
 * 3. Media Extraction: Specifically pulls highest-bitrate MP4s for GIFs and Videos.
 * 4. Persistence: Keeps data safe in window.__scrapedTweets as you scroll.
 */

(function () {
    window.__scrapedTweets = new Map();
    console.log("%c >>> X BULLETPROOF SCRAPER V3 INITIALIZED <<< ", "background: #1d9bf0; color: white; font-weight: bold; padding: 4px;");
    console.log("1. Scroll down Eric's feed. \n2. You'll see 'CAPTURED' logs.\n3. When done, run: %cexportScrapedData()", "color: #1d9bf0; font-weight: bold;");

    // --- INTERCEPTION LAYER ---

    const handleData = (data) => {
        if (!data) return;
        let count = 0;

        function findTweets(obj) {
            if (!obj || typeof obj !== 'object') return;

            // Check if this object looks like a Tweet entry
            const hasId = obj.rest_id || obj.id_str || (obj.legacy && obj.legacy.id_str);
            const hasText = obj.legacy?.full_text || obj.full_text || obj.text;

            if (hasId && hasText) {
                const legacy = obj.legacy || obj;
                const id = obj.rest_id || obj.id_str || legacy.id_str;

                if (id && !window.__scrapedTweets.has(id)) {
                    const extractedMedia = [];
                    const entities = legacy.extended_entities || legacy.entities || obj.extended_entities;

                    if (entities && entities.media) {
                        entities.media.forEach(m => {
                            if (m.video_info && m.video_info.variants) {
                                // Find highest bitrate MP4
                                const mp4s = m.video_info.variants
                                    .filter(v => v.content_type === 'video/mp4' && v.bitrate)
                                    .sort((a, b) => b.bitrate - a.bitrate);

                                const bestVariant = mp4s[0] || m.video_info.variants[0];
                                extractedMedia.push({
                                    type: m.type, // 'video' or 'animated_gif'
                                    url: bestVariant.url,
                                    thumbnail: m.media_url_https
                                });
                            } else {
                                extractedMedia.push({
                                    type: 'photo',
                                    url: m.media_url_https
                                });
                            }
                        });
                    }

                    window.__scrapedTweets.set(id, {
                        status_id: id,
                        url: `https://x.com/i/status/${id}`,
                        text: legacy.full_text || legacy.text || "",
                        created_at: legacy.created_at,
                        metrics: {
                            likes: legacy.favorite_count || 0,
                            retweets: legacy.retweet_count || 0,
                            replies: legacy.reply_count || 0,
                            views: (obj.views?.count) || "N/A"
                        },
                        media: extractedMedia
                    });
                    count++;
                }
            }

            // Recurse deeper
            for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                    findTweets(obj[key]);
                }
            }
        }

        findTweets(data);
        if (count > 0) {
            console.log(`%c CAPTURED: +${count} unique posts (Total: ${window.__scrapedTweets.size}) `, "background: #22c55e; color: white;");
        }
    };

    // Patch Fetch
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0] instanceof Request ? args[0].url : args[0];

        if (url.includes('graphql') || url.includes('timeline')) {
            const clone = response.clone();
            clone.json().then(handleData).catch(() => { });
        }
        return response;
    };

    // Patch XHR
    const xmlOpen = XMLHttpRequest.prototype.open;
    const xmlSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._url = url;
        return xmlOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', function () {
            if (this._url && (this._url.includes('graphql') || this._url.includes('timeline'))) {
                try {
                    handleData(JSON.parse(this.responseText));
                } catch (e) { }
            }
        });
        return xmlSend.apply(this, arguments);
    };

    // --- EXPORT FUNCTION ---

    window.exportScrapedData = function () {
        const data = Array.from(window.__scrapedTweets.values());
        if (data.length === 0) {
            console.error("No data captured yet. Ensure you are scrolling and network requests are happening.");
            return;
        }

        const filename = `eric_full_feed_${Date.now()}.json`;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        console.log(`%c SUCCESS: Exported ${data.length} posts to ${filename} `, "background: #1d9bf0; color: white; font-weight: bold;");
    };
})();
