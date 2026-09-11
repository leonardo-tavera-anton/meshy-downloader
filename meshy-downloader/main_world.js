// main_world.js — Runs in the page's MAIN world (not isolated)
// Hooks page APIs to capture only the credentials required by the local decoder.

(function () {
    const originalPostMessage = Worker.prototype.postMessage;

    function publish(type, detail) {
        window.dispatchEvent(new CustomEvent(type, {
            detail: JSON.stringify(detail)
        }));
    }

    Worker.prototype.postMessage = function (msg, transfer) {
        try {
            if (msg && msg.type === 'authorize' && msg.hostname && msg.signature) {
                publish('__meshy_auth__', {
                    hostname: String(msg.hostname),
                    timestamp: Number(msg.timestamp),
                    signature: String(msg.signature)
                });
            }
        } catch (e) {
            // Keep the page's worker behavior intact if the bridge cannot inspect a message.
        }
        return originalPostMessage.call(this, msg, transfer);
    };

    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        try {
            const request = args[0];
            const options = args[1] || {};
            const url = typeof request === 'string' ? request : request?.url;
            const headers = new Headers(options.headers || request?.headers);
            const authorization = headers.get('Authorization');

            if (url && url.includes('api.meshy.ai') && authorization?.startsWith('Bearer ')) {
                publish('__meshy_token__', { token: authorization.slice(7) });
            }
        } catch (e) {
            // Never interfere with the original request.
        }
        return originalFetch.apply(this, args);
    };
})();
