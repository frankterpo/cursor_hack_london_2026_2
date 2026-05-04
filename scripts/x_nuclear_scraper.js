/**
 * X.com "Nuclear" Emergency Scraper (V4)
 * 
 * Instructions:
 * 1. REFRESH X.com page first.
 * 2. Paste this code and press Enter.
 * 3. Look at your Console. It SHOULD show "INTERCEPTION ACTIVE".
 * 4. Scroll. Every time we catch a data packet, it will log ">>> PACKET [X] CAPTURED".
 * 5. If you DON'T see those logs while scrolling, the script isn't hitting the right requests.
 */

(function () {
    window.__rawPackets = [];
    window.__scrapedTweets = new Map();

    console.clear();
    console.log("%c >>> X NUCLEAR SCRAPER V4 ACTIVE <<< ", "background: red; color: white; font-weight: bold; font-size: 20px; padding: 10px;");
    console.log("1. SCROLL DOWN NOW.");
    console.log("2. Watch for '>>> PACKET CAPTURED' logs.");
    console.log("3. When done, run: %cexportScrapedData()", "color: yellow; font-size: 16px; font-weight: bold;");

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0] instanceof Request ? args[0].url : args[0];

        // Target anything that looks like X's data endpoints
        if (url.includes('graphql') || url.includes('timeline') || url.includes('UserTweets')) {
            try {
                const clone = response.clone();
                const json = await clone.json();
                processDataPacket(json, url);
            } catch (e) { }
        }
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', function () {
            if (this._url && (this._url.includes('graphql') || this._url.includes('timeline'))) {
                try {
                    const json = JSON.parse(this.responseText);
                    processDataPacket(json, this._url);
                } catch (e) { }
            }
        });
        return originalSend.apply(this, arguments);
    };

    function processDataPacket(data, url) {
        window.__rawPackets.push(data);
        let found = 0;

        // Recursive search for anything that looks like a tweet
        function find(obj) {
            if (!obj || typeof obj !== 'object') return;

            // Pattern: has legacy, rest_id, and full_text
            const isTweet = (obj.legacy && obj.rest_id && obj.legacy.full_text);

            if (isTweet) {
                const id = obj.rest_id;
                if (!window.__scrapedTweets.has(id)) {
                    const t = obj.legacy;

                    // Extract Media
                    const media = [];
                    const entities = t.extended_entities || t.entities;
                    if (entities && entities.media) {
                        entities.media.forEach(m => {
                            if (m.video_info) {
                                const variants = m.video_info.variants
                                    .filter(v => v.content_type === 'video/mp4')
                                    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                                media.push({ type: m.type, url: variants[0]?.url || m.media_url_https });
                            } else {
                                media.push({ type: 'photo', url: m.media_url_https });
                            }
                        });
                    }

                    window.__scrapedTweets.set(id, {
                        id,
                        text: t.full_text,
                        created_at: t.created_at,
                        metrics: { likes: t.favorite_count, rts: t.retweet_count, views: obj.views?.count },
                        media
                    });
                    found++;
                }
            }

            for (const k in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, k)) find(obj[k]);
            }
        }

        find(data);
        if (found > 0) {
            console.log(`%c >>> PACKET CAPTURED: +${found} Tweets (Total: ${window.__scrapedTweets.size}) `, "background: green; color: white; border-radius: 4px;");
        } else {
            // Log that we saw a packet but found no tweets (debugging X's weird changes)
            console.log(`%c [DEBUG] Scanned packet from ${url.split('/').pop().split('?')[0]} - No new tweets found inside.`, "color: #888;");
        }
    }

    window.exportScrapedData = function () {
        const data = Array.from(window.__scrapedTweets.values());
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `X_DATA_EXPORT_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        console.log("%c DOWNLOAD STARTED ", "background: blue; color: white;");
    };
})();
